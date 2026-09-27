/**
 * R2 presigned GET 的 SigV4 实现正确性。
 *
 * 这不是「用自己的实现验证自己」：这里用 **AWS 官方公布的测试向量**校验签名链，
 * canonical request / string-to-sign 由测试手工按规范拼出来（可以对着 AWS 文档逐字符读）。
 *
 *   1. AWS 文档「Examples of the complete Version 4 signing process」的 IAM ListUsers 示例；
 *   2. aws-sig-v4-test-suite 的 get-vanilla（换一组 region / service，验证签名链与范围无关）。
 *
 * 这里覆盖的是算法与规范编码本身（签名链各环节逐字符对齐官方标准）。
 */
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import {
  MAX_PRESIGN_TTL_SECONDS,
  PRESIGNED_SOURCE_TTL_SECONDS,
  R2PresignError,
  presignR2Get,
  r2ObjectUrl,
  signCanonicalRequest,
  uriEncode,
  type R2SigningCredentials,
} from "../src/transcription/r2_presign";

const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("SigV4：官方测试向量", () => {
  it("AWS 文档完整示例（GET https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08）", async () => {
    const amzDate = "20150830T123600Z";
    const dateStamp = "20150830";
    const host = "iam.amazonaws.com";
    const canonicalRequest = [
      "GET",
      "/",
      "Action=ListUsers&Version=2010-05-08",
      `content-type:application/x-www-form-urlencoded; charset=utf-8\nhost:${host}\nx-amz-date:${amzDate}\n`,
      "content-type;host;x-amz-date",
      EMPTY_PAYLOAD_SHA256,
    ].join("\n");

    expect(await sha256Hex(canonicalRequest)).toBe("f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59");
    expect(
      await signCanonicalRequest({ canonicalRequest, amzDate, dateStamp, region: "us-east-1", service: "iam", secretAccessKey: AWS_SECRET }),
    ).toBe("5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
  });

  it("aws-sig-v4-test-suite / get-vanilla（region 与 service 参与签名链）", async () => {
    const amzDate = "20150830T123600Z";
    const dateStamp = "20150830";
    const host = "example.amazonaws.com";
    const canonicalRequest = [
      "GET",
      "/",
      "",
      `host:${host}\nx-amz-date:${amzDate}\n`,
      "host;x-amz-date",
      EMPTY_PAYLOAD_SHA256,
    ].join("\n");

    expect(
      await signCanonicalRequest({ canonicalRequest, amzDate, dateStamp, region: "us-east-1", service: "service", secretAccessKey: AWS_SECRET }),
    ).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });
});

describe("uriEncode：SigV4 的编码规则（比 encodeURIComponent 更严）", () => {
  it.each([
    ["a b", "a%20b"], // 空格是 %20，不是 +
    ["a+b", "a%2Bb"],
    ["a*b", "a%2Ab"], // encodeURIComponent 会漏掉 * ! ' ( )
    ["a!b'c(d)e", "a%21b%27c%28d%29e"],
    ["~-_.~", "~-_.~"], // 非保留字符不编码
    ["a/b", "a%2Fb"],
    ["测试/播客", "%E6%B5%8B%E8%AF%95%2F%E6%92%AD%E5%AE%A2"],
    ["a%2Fb", "a%252Fb"], // 已是百分号转义的要再转义一次
  ])("%s → %s", (input, expected) => {
    expect(uriEncode(input)).toBe(expected);
  });

  it("encodeSlash=false 只用于 object key 的路径部分", () => {
    expect(uriEncode("uploads/up-1/talk.mp3", false)).toBe("uploads/up-1/talk.mp3");
    expect(uriEncode("uploads/up-1/我的 录音.mp3", false)).toBe("uploads/up-1/%E6%88%91%E7%9A%84%20%E5%BD%95%E9%9F%B3.mp3");
  });
});

describe("presignR2Get：URL 的形状与约束", () => {
  const credentials: R2SigningCredentials = {
    accountId: "acct",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: AWS_SECRET,
    bucket: "my-bucket",
  };
  const at = Date.UTC(2026, 8, 21, 10, 0, 0); // 20260921T100000Z

  it("指向确切 key；host 是 R2 的 S3 endpoint；只签 host", async () => {
    const url = await presignR2Get(credentials, "uploads/up-1/talk.mp3", at);
    const parsed = new URL(url);

    expect(parsed.origin).toBe("https://acct.r2.cloudflarestorage.com");
    expect(decodeURIComponent(parsed.pathname)).toBe("/my-bucket/uploads/up-1/talk.mp3");
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(parsed.searchParams.get("X-Amz-Credential")).toBe("AKIDEXAMPLE/20260921/auto/s3/aws4_request");
    expect(parsed.searchParams.get("X-Amz-Date")).toBe("20260921T100000Z");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe(String(PRESIGNED_SOURCE_TTL_SECONDS));
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    // 没有 session token / 没有写操作参数
    expect(parsed.searchParams.has("X-Amz-Security-Token")).toBe(false);
    expect(url).not.toContain("uploadId");
    expect(url).not.toContain("partNumber");
  });

  it("key 里的空格 / 中文按 SigV4 规则编码（签名与 URL 用同一份编码）", async () => {
    const url = await presignR2Get(credentials, "uploads/up-1/我的 录音.mp3", at);
    expect(url).toContain("/my-bucket/uploads/up-1/%E6%88%91%E7%9A%84%20%E5%BD%95%E9%9F%B3.mp3?");
    const signature = new URL(url).searchParams.get("X-Amz-Signature")!;
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("确定性：同样的 key + 时间戳 → 同样的 URL（不引入随机数）", async () => {
    const first = await presignR2Get(credentials, "uploads/up-1/talk.mp3", at);
    const second = await presignR2Get(credentials, "uploads/up-1/talk.mp3", at);
    expect(first).toBe(second);
  });

  it("不同的 key / 不同的时间戳 / 不同的 TTL → 不同签名（签名真的绑定了这些输入）", async () => {
    const base = await presignR2Get(credentials, "uploads/up-1/talk.mp3", at);
    const otherKey = await presignR2Get(credentials, "uploads/up-2/talk.mp3", at);
    const later = await presignR2Get(credentials, "uploads/up-1/talk.mp3", at + 1000);
    const longer = await presignR2Get(credentials, "uploads/up-1/talk.mp3", at, PRESIGNED_SOURCE_TTL_SECONDS + 1);
    const otherSecret = await presignR2Get({ ...credentials, secretAccessKey: `${AWS_SECRET}x` }, "uploads/up-1/talk.mp3", at);
    expect(new Set([base, otherKey, later, longer, otherSecret]).size).toBe(5);
  });

  it("method 固定为 GET：canonical request 的第一行写死 GET（没有签发写操作的路径）", async () => {
    // 用同样的输入手工拼出 GET 的 canonical request，签名必须与实现一致——
    // 反过来说，任何方法变化都会改变签名，而实现里根本没有可变的方法入口。
    const url = await presignR2Get(credentials, "uploads/up-1/talk.mp3", at);
    const parsed = new URL(url);
    const canonicalQuery = [...parsed.searchParams.entries()]
      .filter(([name]) => name !== "X-Amz-Signature")
      .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, value]) => `${name}=${value}`)
      .join("&");
    const canonicalRequest = [
      "GET",
      "/my-bucket/uploads/up-1/talk.mp3",
      canonicalQuery,
      "host:acct.r2.cloudflarestorage.com\n",
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    expect(
      await signCanonicalRequest({
        canonicalRequest,
        amzDate: "20260921T100000Z",
        dateStamp: "20260921",
        region: "auto",
        service: "s3",
        secretAccessKey: AWS_SECRET,
      }),
    ).toBe(parsed.searchParams.get("X-Amz-Signature"));
  });

  it("拒绝对不安全的 key 或非法 TTL 签发", async () => {
    for (const bad of ["", "/abs/path", "uploads/../raw/x", "a/../b"]) {
      await expect(presignR2Get(credentials, bad, at)).rejects.toBeInstanceOf(R2PresignError);
    }
    for (const ttl of [0, -1, 1.5, MAX_PRESIGN_TTL_SECONDS + 1]) {
      await expect(presignR2Get(credentials, "uploads/up-1/a.mp3", at, ttl)).rejects.toBeInstanceOf(R2PresignError);
    }
  });

  it("缺少任何一项签发凭据都直接失败（不会签出一个无效 URL）", async () => {
    for (const field of ["accountId", "accessKeyId", "secretAccessKey", "bucket"] as const) {
      await expect(presignR2Get({ ...credentials, [field]: "" }, "uploads/up-1/a.mp3", at)).rejects.toBeInstanceOf(R2PresignError);
    }
  });

  it("r2ObjectUrl 是不带签名的只读诊断地址", () => {
    expect(r2ObjectUrl(credentials, "uploads/up-1/我的 录音.mp3")).toBe("https://acct.r2.cloudflarestorage.com/my-bucket/uploads/up-1/%E6%88%91%E7%9A%84%20%E5%BD%95%E9%9F%B3.mp3");
  });

  it("TTL 常量在 1–2 小时这个区间（覆盖排队 + 下载，但不覆盖整段转录）", () => {
    expect(PRESIGNED_SOURCE_TTL_SECONDS).toBeGreaterThanOrEqual(3600);
    expect(PRESIGNED_SOURCE_TTL_SECONDS).toBeLessThanOrEqual(2 * 3600);
    expect(MAX_PRESIGN_TTL_SECONDS).toBe(7 * 24 * 3600);
  });
});
