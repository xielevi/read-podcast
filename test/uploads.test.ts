/**
 * 自定义上传：200 MiB 硬上限（authoritative product rule，= 209,715,200 字节）。
 *
 * Cloudflare 在每一个入口执行：初始化 / 单流上传 / 分片 / complete / 最终对象大小 / 创建任务；
 * 前端与转录服务只是各自的防御性副本。这里不依赖前端：直接调用服务端处理函数即等价于「绕过前端的 API 调用」。
 *
 * 「转录服务怎么读到这个对象」属于 source 解析（见 transcription.test.ts 的 presigned GET）：
 * 读取方式不影响这里的任何上传规则。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_PARTS,
  MAX_PART_BYTES,
  MAX_UPLOAD_BYTES,
  getAudioExtension,
  handleAbortMultipartUpload,
  handleCompleteMultipartUpload,
  handleStartMultipartUpload,
  handleUploadAudio,
  handleUploadPart,
  sanitizeFilename,
} from "../src/uploads";
import { makeCloud, syntheticStream, type Cloud } from "./helpers/cloud";

const CAP = 200 * 1024 * 1024;

const startReq = (query = "filename=talk.mp3") => new Request(`https://edge/uploads/multipart/start?${query}`, { method: "POST" });
const start = (cloud: Cloud, query?: string) => {
  const request = startReq(query);
  return handleStartMultipartUpload(request, new URL(request.url), cloud.env);
};

function partRequest(uploadId: string, r2UploadId: string, key: string, body: ReadableStream<Uint8Array> | null, headers: Record<string, string> = {}) {
  return new Request(`https://edge/uploads/multipart/${uploadId}/parts/1`, {
    method: "PUT",
    headers: { "x-r2-upload-id": r2UploadId, "x-upload-key": key, ...headers },
    body,
    ...(body ? ({ duplex: "half" } as Record<string, string>) : {}),
  });
}

async function begin(cloud: Cloud) {
  const response = await start(cloud);
  return (await response.json()) as { upload_id: string; r2_upload_id: string; key: string };
}

// 分片默认带上与 body 一致的 Content-Length（浏览器 fetch(Blob) 的真实行为）；传 null 模拟 chunked（无长度）。
async function uploadPart(cloud: Cloud, init: { upload_id: string; r2_upload_id: string; key: string }, partNumber: number, size: number, headers: Record<string, string | null> = {}) {
  const finalHeaders: Record<string, string> = {};
  const merged: Record<string, string | null> = { "content-length": String(size), ...headers };
  for (const [key, value] of Object.entries(merged)) if (value !== null) finalHeaders[key] = value;
  const request = partRequest(init.upload_id, init.r2_upload_id, init.key, syntheticStream(size), finalHeaders);
  return handleUploadPart(request, init.upload_id, String(partNumber), cloud.env);
}

const completeReq = (body: unknown) => new Request("https://edge/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("常量：200 MiB 是唯一的产品硬上限", () => {
  it("MAX_UPLOAD_BYTES = 209,715,200；分片 10 MiB；最多 20 片（不再是 50 × 10 MB = 500 MB）", () => {
    expect(MAX_UPLOAD_BYTES).toBe(200 * 1024 * 1024);
    expect(MAX_UPLOAD_BYTES).toBe(209_715_200);
    expect(MAX_PART_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_PARTS).toBe(20);
    expect(MAX_PARTS * MAX_PART_BYTES).toBe(MAX_UPLOAD_BYTES); // 分片上限恰好推出总上限：累计无法绕过
  });
});

describe("sanitizeFilename / getAudioExtension", () => {
  it("strips directory traversal and invalid characters", () => {
    expect(sanitizeFilename("../../secret.mp3")).toBe("secret.mp3");
    expect(sanitizeFilename("foo/bar\\baz:qux?.m4a")).toBe("baz_qux_.m4a");
    expect(sanitizeFilename("..")).toBe("audio.mp3");
    expect(sanitizeFilename("normal-audio.wav")).toBe("normal-audio.wav");
  });

  it("getAudioExtension lowercases and handles missing extension", () => {
    expect(getAudioExtension("Talk.MP3")).toBe(".mp3");
    expect(getAudioExtension("noext")).toBe("");
  });
});

describe("单流上传 POST /uploads", () => {
  // R2 只接受已知长度的流：单请求上传必须带 Content-Length（默认按 size 带上；传 null 表示不带）。
  const upload = (cloud: Cloud, size: number, headers: Record<string, string | null> = {}, filename = "talk.mp3") => {
    const finalHeaders: Record<string, string> = {};
    const merged: Record<string, string | null> = { "content-length": String(size), ...headers };
    for (const [key, value] of Object.entries(merged)) if (value !== null) finalHeaders[key] = value;
    const request = new Request(`https://edge/uploads?filename=${filename}`, {
      method: "POST",
      headers: finalHeaders,
      body: syntheticStream(size),
      ...({ duplex: "half" } as Record<string, string>),
    });
    return handleUploadAudio(request, new URL(request.url), cloud.env);
  };

  it("拒绝不受支持的扩展名", async () => {
    const cloud = makeCloud();
    await expect(upload(cloud, 3, {}, "malicious.exe")).rejects.toThrow("Unsupported audio extension");
  });

  it.each([
    ["200 MiB − 1 字节", CAP - 1],
    ["恰好 200 MiB", CAP],
  ])("%s：成功写入 R2 uploads/ 前缀，并回报 R2 里真实的对象大小", async (_label, size) => {
    const cloud = makeCloud();
    const res = await upload(cloud, size);
    const body = (await res.json()) as { size: number; key: string };
    expect(res.status).toBe(200);
    expect(body.size).toBe(size);
    expect(body.key).toMatch(/^uploads\/[0-9a-f-]{36}\/talk\.mp3$/);
    expect(cloud.r2.keys("uploads/")).toEqual([body.key]);
  });

  it("200 MiB + 1 字节：声明的 Content-Length 超限 → 413，在读取 body / 写 R2 之前就拒绝", async () => {
    const cloud = makeCloud();
    await expect(upload(cloud, CAP + 1)).rejects.toMatchObject({ status: 413, code: "file_too_large" });
    expect(cloud.r2.putLog).toEqual([]);
    expect(cloud.r2.keys("uploads/")).toEqual([]);
  });

  it("缺 Content-Length（R2 无法接收未知长度的流）→ 411 length_required，不写 R2", async () => {
    const cloud = makeCloud();
    await expect(upload(cloud, 1024, { "content-length": null })).rejects.toMatchObject({ status: 411, code: "length_required" });
    expect(cloud.r2.putLog).toEqual([]);
  });

  it.each(["abc", "-5", "1.5"])("非法 Content-Length=%s → 400", async value => {
    const cloud = makeCloud();
    await expect(upload(cloud, 10, { "content-length": value })).rejects.toMatchObject({ status: 400, code: "invalid_content_length" });
  });

  it("声明撒谎（声明 1024、实际 200 MiB + 1）：R2 落地后以真实对象大小复核 → 413，并销毁对象", async () => {
    const cloud = makeCloud();
    await expect(upload(cloud, CAP + 1, { "content-length": "1024" })).rejects.toMatchObject({ status: 413, code: "file_too_large" });
    expect(cloud.r2.keys("uploads/")).toEqual([]);
    expect(cloud.r2.deleteLog).toHaveLength(1);
  });

  it("空 body → 400", async () => {
    const cloud = makeCloud();
    const request = new Request("https://edge/uploads?filename=a.mp3", { method: "POST" });
    await expect(handleUploadAudio(request, new URL(request.url), cloud.env)).rejects.toMatchObject({ status: 400, code: "empty_body" });
  });
});

describe("分片上传：初始化", () => {
  it("校验文件名与扩展名", async () => {
    const cloud = makeCloud();
    await expect(start(cloud, "")).rejects.toMatchObject({ status: 400, code: "filename_required" });
    await expect(start(cloud, "filename=x.exe")).rejects.toMatchObject({ status: 400, code: "invalid_extension" });
  });

  it("初始化 R2 multipart：返回 upload_id / r2_upload_id / key", async () => {
    const cloud = makeCloud();
    const body = (await (await start(cloud, "filename=..%2F..%2Ftalk.mp3")).json()) as { upload_id: string; r2_upload_id: string; key: string; filename: string };
    expect(body.filename).toBe("talk.mp3");
    expect(body.key).toBe(`uploads/${body.upload_id}/talk.mp3`);
    expect(cloud.r2.multiparts.has(body.r2_upload_id)).toBe(true);
  });

  it.each([
    ["200 MiB − 1", CAP - 1, 200],
    ["恰好 200 MiB", CAP, 200],
    ["200 MiB + 1", CAP + 1, 413],
    ["500 MiB（旧上限）", 500 * 1024 * 1024, 413],
  ])("声明体积 %s → %s（超限在发起 R2 multipart 之前就拒绝）", async (_label, size, status) => {
    const cloud = makeCloud();
    if (status === 200) {
      expect((await start(cloud, `filename=a.mp3&size=${size}`)).status).toBe(200);
    } else {
      await expect(start(cloud, `filename=a.mp3&size=${size}`)).rejects.toMatchObject({ status: 413, code: "file_too_large" });
      expect(cloud.r2.multiparts.size).toBe(0);
    }
  });

  it.each(["-1", "abc", "NaN"])("非法 size=%s → 400", async size => {
    const cloud = makeCloud();
    await expect(start(cloud, `filename=a.mp3&size=${size}`)).rejects.toMatchObject({ status: 400, code: "invalid_size" });
  });
});

describe("分片上传：分片与累计上限", () => {
  it("校验分片编号 / 必需头 / key 归属 / 空 body", async () => {
    const cloud = makeCloud();
    const init = await begin(cloud);
    const req = (n: string, headers: Record<string, string>, body: ReadableStream<Uint8Array> | null = syntheticStream(3)) =>
      handleUploadPart(partRequest(init.upload_id, init.r2_upload_id, init.key, body, headers), init.upload_id, n, cloud.env);

    for (const bad of ["0", "-1", "abc", String(MAX_PARTS + 1), "50"]) {
      await expect(req(bad, {})).rejects.toMatchObject({ status: 400, code: "invalid_part_number" });
    }
    await expect(handleUploadPart(new Request("https://edge/p", { method: "PUT", body: syntheticStream(3), ...({ duplex: "half" } as Record<string, string>) }), init.upload_id, "1", cloud.env)).rejects.toMatchObject({ code: "missing_multipart_headers" });
    await expect(handleUploadPart(partRequest(init.upload_id, init.r2_upload_id, "uploads/other/x.mp3", syntheticStream(3)), init.upload_id, "1", cloud.env)).rejects.toMatchObject({ code: "invalid_key" });
    await expect(handleUploadPart(partRequest(init.upload_id, init.r2_upload_id, init.key, null), init.upload_id, "1", cloud.env)).rejects.toMatchObject({ code: "empty_body" });
  });

  it("单片：10 MiB 成功；10 MiB + 1 字节 413（声明长度超限，在读取 body 之前拒绝）", async () => {
    const cloud = makeCloud();
    const init = await begin(cloud);

    const ok = await uploadPart(cloud, init, 1, MAX_PART_BYTES);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ partNumber: 1 });
    expect(cloud.r2.multiparts.get(init.r2_upload_id)?.parts.get(1)).toBe(MAX_PART_BYTES);

    await expect(uploadPart(cloud, init, 2, MAX_PART_BYTES + 1)).rejects.toMatchObject({ status: 413, code: "part_too_large" });
    expect(cloud.r2.multiparts.get(init.r2_upload_id)?.parts.has(2)).toBe(false);
  });

  it("没有 Content-Length（chunked）的分片：缓冲这一片并逐块计数——≤ 10 MiB 通过，超出 413", async () => {
    const cloud = makeCloud();
    const init = await begin(cloud);

    expect((await uploadPart(cloud, init, 1, MAX_PART_BYTES, { "content-length": null })).status).toBe(200);
    expect(cloud.r2.multiparts.get(init.r2_upload_id)?.parts.get(1)).toBe(MAX_PART_BYTES);
    await expect(uploadPart(cloud, init, 2, MAX_PART_BYTES + 1, { "content-length": null })).rejects.toMatchObject({ status: 413, code: "part_too_large" });
    expect(cloud.r2.multiparts.get(init.r2_upload_id)?.parts.has(2)).toBe(false);
  });

  it("空分片（Content-Length: 0）→ 400", async () => {
    const cloud = makeCloud();
    const init = await begin(cloud);
    await expect(uploadPart(cloud, init, 1, 0)).rejects.toMatchObject({ status: 400, code: "empty_body" });
  });

  it("第 20 片可以上传，第 21 片被拒绝（分片总数上限）", async () => {
    const cloud = makeCloud();
    const init = await begin(cloud);
    expect((await uploadPart(cloud, init, MAX_PARTS, 1024)).status).toBe(200);
    await expect(uploadPart(cloud, init, MAX_PARTS + 1, 1024)).rejects.toMatchObject({ status: 400, code: "invalid_part_number" });
  });

  it("恰好 200 MiB（20 × 10 MiB）完整走通 multipart：complete 成功、对象大小 = 209,715,200", async () => {
    const cloud = makeCloud();
    const init = await begin(cloud);
    const parts = [];
    for (let n = 1; n <= MAX_PARTS; n += 1) {
      const body = (await (await uploadPart(cloud, init, n, MAX_PART_BYTES)).json()) as { partNumber: number; etag: string };
      parts.push({ partNumber: body.partNumber, etag: body.etag });
    }

    const res = await handleCompleteMultipartUpload(completeReq({ r2_upload_id: init.r2_upload_id, key: init.key, parts }), init.upload_id, cloud.env);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ upload_id: init.upload_id, size: CAP });
    expect(cloud.r2.keys("uploads/")).toEqual([init.key]);
  });

  it("200 MiB + 1 字节按 10 MiB 切片需要 21 片：第 21 片被拒，累计无法绕过", async () => {
    const cloud = makeCloud();
    const init = await begin(cloud);
    for (let n = 1; n <= MAX_PARTS; n += 1) await uploadPart(cloud, init, n, MAX_PART_BYTES);
    // 客户端想再补 1 字节：只能是第 21 片
    await expect(uploadPart(cloud, init, MAX_PARTS + 1, 1)).rejects.toMatchObject({ status: 400, code: "invalid_part_number" });
  });
});

describe("分片上传：complete 的权威复核", () => {
  const valid = (init: { r2_upload_id: string; key: string }, parts: unknown[]) => completeReq({ r2_upload_id: init.r2_upload_id, key: init.key, parts });

  it("校验 payload / key 归属", async () => {
    const cloud = makeCloud();
    const init = await begin(cloud);
    await expect(handleCompleteMultipartUpload(completeReq({}), init.upload_id, cloud.env)).rejects.toMatchObject({ code: "invalid_complete_payload" });
    await expect(handleCompleteMultipartUpload(completeReq({ r2_upload_id: init.r2_upload_id, key: "uploads/other/x.mp3", parts: [{ partNumber: 1, etag: "e" }] }), init.upload_id, cloud.env)).rejects.toMatchObject({ code: "invalid_key" });
  });

  it("超过 20 片的 parts 列表 → 400 too_many_parts（不去问 R2）", async () => {
    const cloud = makeCloud();
    const init = await begin(cloud);
    const parts = Array.from({ length: MAX_PARTS + 1 }, (_, i) => ({ partNumber: i + 1, etag: `e${i}` }));
    await expect(handleCompleteMultipartUpload(valid(init, parts), init.upload_id, cloud.env)).rejects.toMatchObject({ status: 400, code: "too_many_parts" });
  });

  it.each([
    ["分片号 0", [{ partNumber: 0, etag: "e" }]],
    ["分片号 21", [{ partNumber: 21, etag: "e" }]],
    ["分片号非整数", [{ partNumber: 1.5, etag: "e" }]],
    ["缺 etag", [{ partNumber: 1, etag: "" }]],
  ])("非法分片声明（%s）→ 400 invalid_part_number", async (_label, parts) => {
    const cloud = makeCloud();
    const init = await begin(cloud);
    await expect(handleCompleteMultipartUpload(valid(init, parts), init.upload_id, cloud.env)).rejects.toMatchObject({ status: 400, code: "invalid_part_number" });
  });

  it("重复的分片号 → 400 duplicate_part_number", async () => {
    const cloud = makeCloud();
    const init = await begin(cloud);
    await expect(handleCompleteMultipartUpload(valid(init, [{ partNumber: 1, etag: "a" }, { partNumber: 1, etag: "b" }]), init.upload_id, cloud.env)).rejects.toMatchObject({ code: "duplicate_part_number" });
  });

  it("以真实组装出的对象大小为准：实际 >200 MiB（绕过分片累计的极端情形）→ 413 且对象被销毁", async () => {
    const cloud = makeCloud();
    const init = await begin(cloud);
    await uploadPart(cloud, init, 1, 1024);
    cloud.r2.assembledSizeOverride = CAP + 1; // R2 里真实存在的超限对象

    await expect(handleCompleteMultipartUpload(valid(init, [{ partNumber: 1, etag: "e" }]), init.upload_id, cloud.env)).rejects.toMatchObject({ status: 413, code: "file_too_large" });

    expect(cloud.r2.keys("uploads/")).toEqual([]);
    expect(cloud.r2.deleteLog).toContain(init.key);
  });

  it("真实对象恰好 200 MiB → 通过", async () => {
    const cloud = makeCloud();
    const init = await begin(cloud);
    await uploadPart(cloud, init, 1, 1024);
    cloud.r2.assembledSizeOverride = CAP;
    expect((await handleCompleteMultipartUpload(valid(init, [{ partNumber: 1, etag: "e" }]), init.upload_id, cloud.env)).status).toBe(200);
  });

  it("abort：中止并返回 ok；校验 payload / key", async () => {
    const cloud = makeCloud();
    const init = await begin(cloud);
    await expect(handleAbortMultipartUpload(completeReq({}), init.upload_id, cloud.env)).rejects.toMatchObject({ code: "invalid_abort_payload" });
    const res = await handleAbortMultipartUpload(completeReq({ r2_upload_id: init.r2_upload_id, key: init.key }), init.upload_id, cloud.env);
    expect(await res.json()).toEqual({ ok: true, aborted: true });
    expect(cloud.r2.multiparts.get(init.r2_upload_id)?.aborted).toBe(true);
  });
});

describe("前端：立即拒绝超限文件，不进入上传流程", () => {
  // 从 public/js/20-subscriptions.js 抽出 doUploadAudio，放进带桩的沙箱执行（真实文件，不是复制的逻辑）。
  const source = readFileSync(new URL("../public/js/20-subscriptions.js", import.meta.url), "utf-8");
  const start = source.indexOf("function doUploadAudio(file) {");
  let depth = 0;
  let end = start;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const functionSource = source.slice(start, end);

  function sandbox() {
    const elements = new Map<string, { textContent: string; style: Record<string, string>; hidden?: boolean }>();
    const logs: Array<[string, string]> = [];
    const fetched: string[] = [];
    const byId = (id: string) => {
      if (!elements.has(id)) elements.set(id, { textContent: "", style: {} });
      return elements.get(id)!;
    };
    const fetchStub = (url: string) => {
      fetched.push(url);
      return new Promise(() => undefined); // 永不返回：只关心是否发起
    };
    // 这里验证的是控制模式里的体积校验，requireControl 恒为 true；匿名拦截见 browse_mode.test.ts。
    const run = new Function("byId", "addLog", "setHidden", "appUrl", "fetch", "setTimeout", "requireControl", "readApiResponse", `var _uploadedAudioPath, _uploadedAudioTitle; ${functionSource}; return doUploadAudio;`);
    const doUploadAudio = run(byId, (message: string, level: string) => logs.push([message, level]), (element: { hidden?: boolean }, hidden: boolean) => void (element.hidden = hidden), (path: string) => path, fetchStub, setTimeout, () => true, (response: Response) => response.json());
    return { doUploadAudio, byId, logs, fetched };
  }

  it("200 MiB + 1 字节：立即提示并返回，不发起任何请求", () => {
    const { doUploadAudio, byId, logs, fetched } = sandbox();
    doUploadAudio({ name: "big.mp3", size: CAP + 1 });
    expect(fetched).toEqual([]);
    expect(byId("upload-status").textContent).toContain("200 MiB");
    expect(logs[0]).toEqual(["文件体积超出 200 MiB 上限", "error"]);
  });

  it("500 MiB（旧上限内）同样被拒绝", () => {
    const { doUploadAudio, fetched } = sandbox();
    doUploadAudio({ name: "big.mp3", size: 400 * 1024 * 1024 });
    expect(fetched).toEqual([]);
  });

  it.each([CAP - 1, CAP])("%i 字节：进入上传流程，并把真实体积随初始化请求一并声明", size => {
    const { doUploadAudio, fetched } = sandbox();
    doUploadAudio({ name: "ok.mp3", size, type: "audio/mpeg" });
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain("/api/control/uploads/multipart/start?filename=ok.mp3");
    expect(fetched[0]).toContain(`&size=${size}`);
  });

  it("前端切片大小与服务端上限一致：200 MiB 恰好 20 片", () => {
    expect(source).toContain("var CHUNK_SIZE = 10 * 1024 * 1024");
    expect(Math.ceil(CAP / (10 * 1024 * 1024))).toBe(MAX_PARTS);
  });

  it("源码里不再有旧的 500 MB 上限", () => {
    expect(source).not.toMatch(/500 \* 1024 \* 1024|500 MB/);
  });
});
