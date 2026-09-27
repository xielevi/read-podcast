/**
 * R2 的 S3 兼容**预签名 GET**（AWS Signature Version 4，query-string 形式）。
 *
 * 为什么需要它：自定义上传的音频存放在 R2，而 Transcription Service 是 Cloudflare 外部的一台
 * 可替换计算节点。让 Cloudflare Worker 自己当中转（`R2 → Worker → 转录服务`）意味着 Worker 要把
 * 最多 200 MiB 的音频流原样转发一遍，还要自建一套签名 / 端点 / 密钥，并与主站的 Access 保护冲突。
 * 改成 `R2 → 转录服务` 之后：
 *
 *   - 转录服务只拿到一个**临时 URL**，不持有任何 R2 / Cloudflare 凭据；
 *   - Cloudflare 只签发 URL，不搬运字节；
 *   - 撤销能力 = 到期自动失效；授权范围 = 单个 object key + 只读。
 *
 * 实现用的是 Workers 原生的 WebCrypto（`crypto.subtle`），没有 Node 专属依赖，也不需要额外的
 * SigV4 库——签名过程本身用官方的 SigV4 测试向量验证（见 test/r2_presign.test.ts）。
 *
 * 只做 GET：canonical request 的 method 固定为 `GET`，`X-Amz-SignedHeaders=host`，
 * payload 为 `UNSIGNED-PAYLOAD`。没有 PUT / DELETE / list 的签发路径。
 */
import { sha256Hex, toHex } from "../crypto";

/** SigV4 的固定部分：R2 的区域恒为 `auto`，服务名是 `s3`。 */
const ALGORITHM = "AWS4-HMAC-SHA256";
const REGION = "auto";
const SERVICE = "s3";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const SIGNED_HEADERS = "host";

/**
 * 预签名 source URL 的有效期（秒）。
 *
 * URL 的用途只有一件事：让转录服务把音频抓成本地临时文件。之后的 Whisper 转录可以跑几小时，
 * 但那已经不需要这个 URL 了。所以要覆盖的是「提交 + provider 排队 + 下载 + 网络抖动」，
 * 而不是整段计算时间。
 *
 * 下限约束：一个 durable submission 内 URL 必须**始终是同一个**（见 workflows/transcription.ts
 * 的 resolve-source-N step），所以 TTL 不能短到 Workflow 自己正常 retry 时就失效。
 * 2 小时对「排队几十秒 + 下载几分钟」是很宽的余量，同时把一张泄露的 URL 的可用窗口压到最小。
 */
export const PRESIGNED_SOURCE_TTL_SECONDS = 2 * 60 * 60;

/** R2 / S3 允许的最大 `X-Amz-Expires`（7 天）。 */
export const MAX_PRESIGN_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface R2SigningCredentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export class R2PresignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "R2PresignError";
  }
}

const encoder = new TextEncoder();

async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}


/**
 * SigV4 的 URI 编码（RFC 3986 非保留字符之外一律百分号编码）。
 * `encodeURIComponent` 会漏掉 `!'()*` 且按 UTF-16 码元处理，这里按字节处理。
 * `encodeSlash = false` 只用于 object key 的路径部分（`/` 是路径分隔符，不编码）。
 */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const byte of encoder.encode(value)) {
    const char = String.fromCharCode(byte);
    const unreserved =
      (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39);
    if (unreserved || char === "-" || char === "_" || char === "." || char === "~") out += char;
    else if (char === "/" && !encodeSlash) out += char;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function amzDateParts(nowMs: number): { amzDate: string; dateStamp: string } {
  const iso = new Date(nowMs).toISOString();
  return { amzDate: iso.replace(/[:-]|\.\d{3}/g, ""), dateStamp: iso.slice(0, 10).replace(/-/g, "") };
}

/**
 * SigV4 的核心：由 canonical request 算出十六进制签名。
 *
 *   scope        = <date>/<region>/<service>/aws4_request
 *   stringToSign = "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + SHA256(canonicalRequest)
 *   kSigning     = HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request")
 *   signature    = HMAC(kSigning, stringToSign)   （十六进制）
 *
 * 单独导出的原因：官方的 SigV4 测试向量（AWS 文档的完整示例、aws-sig-v4-test-suite）校验的正是
 * 这一层——测试可以手工拼出 canonical request，然后断言签名与 AWS 公布的值逐字节一致。
 */
export async function signCanonicalRequest(params: {
  canonicalRequest: string;
  amzDate: string;
  dateStamp: string;
  region: string;
  service: string;
  secretAccessKey: string;
}): Promise<string> {
  const scope = `${params.dateStamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = [ALGORITHM, params.amzDate, scope, await sha256Hex(params.canonicalRequest)].join("\n");
  const secret = encoder.encode(`AWS4${params.secretAccessKey}`);
  const signingKey = await hmac(await hmac(await hmac(await hmac(secret, params.dateStamp), params.region), params.service), "aws4_request");
  return toHex(await hmac(signingKey, stringToSign));
}

export function r2Endpoint(credentials: R2SigningCredentials): string {
  return `https://${credentials.accountId}.r2.cloudflarestorage.com`;
}

/** 给定 object key 的只读路径地址（不是签名 URL；仅用于断言 / 诊断）。 */
export function r2ObjectUrl(credentials: R2SigningCredentials, objectKey: string): string {
  return `${r2Endpoint(credentials)}/${uriEncode(credentials.bucket, true)}/${uriEncode(objectKey, false)}`;
}

/**
 * 为**一个确定的 object key** 生成预签名 GET URL。
 *
 * 返回值是完整的 https URL：可以直接交给任何外部节点取回该对象，有效期 `ttlSeconds`。
 * 同一组入参（key + 时间戳 + TTL）得到的 URL 完全确定——不引入随机数，便于断言与排查。
 */
export async function presignR2Get(
  credentials: R2SigningCredentials,
  objectKey: string,
  nowMs: number = Date.now(),
  ttlSeconds: number = PRESIGNED_SOURCE_TTL_SECONDS,
): Promise<string> {
  for (const field of ["accountId", "accessKeyId", "secretAccessKey", "bucket"] as const) {
    if (!String(credentials[field] ?? "").trim()) throw new R2PresignError(`R2 signing credential '${field}' is missing`);
  }
  if (!objectKey || objectKey.startsWith("/") || objectKey.includes("..")) {
    throw new R2PresignError("object key must be a non-empty relative key without parent traversal");
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_PRESIGN_TTL_SECONDS) {
    throw new R2PresignError(`ttlSeconds must be an integer between 1 and ${MAX_PRESIGN_TTL_SECONDS}`);
  }

  const host = new URL(r2Endpoint(credentials)).host;
  const { amzDate, dateStamp } = amzDateParts(nowMs);
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  const query: Array<[string, string]> = [
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${credentials.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(ttlSeconds)],
    ["X-Amz-SignedHeaders", SIGNED_HEADERS],
  ];
  // 规范查询串：按编码后的 name 排序（本组参数天然有序，仍然显式排一次以免将来加参数时出错）。
  const canonicalQuery = query
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort(([aName, aValue], [bName, bValue]) => (aName === bName ? (aValue < bValue ? -1 : 1) : aName < bName ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");

  const canonicalRequest = [
    "GET",
    `/${uriEncode(credentials.bucket)}/${uriEncode(objectKey, false)}`,
    canonicalQuery,
    `host:${host}\n`,
    SIGNED_HEADERS,
    UNSIGNED_PAYLOAD,
  ].join("\n");

  const signature = await signCanonicalRequest({
    canonicalRequest,
    amzDate,
    dateStamp,
    region: REGION,
    service: SERVICE,
    secretAccessKey: credentials.secretAccessKey,
  });

  return `${r2Endpoint(credentials)}/${uriEncode(credentials.bucket)}/${uriEncode(objectKey, false)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}