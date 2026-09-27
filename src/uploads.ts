import { HttpError, error, json, readJson } from "./http";
import { MAX_PARTS, MAX_PART_BYTES, MAX_UPLOAD_BYTES } from "./limits";
import { readBoundedStream } from "./net/bounded";
import type { Env } from "./types";

export { MAX_PARTS, MAX_PART_BYTES, MAX_UPLOAD_BYTES };

const MIB = 1024 * 1024;
const capLabel = `${MAX_UPLOAD_BYTES / MIB} MiB`;

const ALLOWED_EXTENSIONS = new Set([
  ".mp3",
  ".m4a",
  ".wav",
  ".flac",
  ".ogg",
  ".aac",
  ".opus",
  ".wma",
]);

export function sanitizeFilename(raw: string): string {
  const base = raw.replace(/^.*[/\\]/, "").trim();
  const safe = base.replace(/[/\\?%*:|"<>'\0-\x1f\x7f]+/g, "_").trim();
  return safe.replace(/^\.+/, "") || "audio.mp3";
}

export function getAudioExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex < 0) return "";
  return filename.slice(dotIndex).toLowerCase();
}

/**
 * R2 只接受「已知长度」的流：请求体（request.body）带 Content-Length 时长度已知，但任何 pipeThrough(TransformStream)
 * 之后的流长度未知，R2 会以 `Provided readable stream must have a known length` 拒绝。因此上限的执行方式是：
 *   1. 以声明的 Content-Length 判上限（运行时保证 body 恰好就是这个长度）；
 *   2. 把**原始 request.body** 交给 R2；
 *   3. R2 落地后再用真实对象大小复核一次（声明与实际不符的极端情形）。
 */
function declaredLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new HttpError(400, "invalid_content_length", "Content-Length must be a non-negative integer");
  }
  return value;
}

/** 没有 Content-Length（chunked）的分片：最多缓冲一个分片（≤ MAX_PART_BYTES）并逐块计数。 */
function bufferPart(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return readBoundedStream(body, MAX_PART_BYTES, () => new HttpError(413, "part_too_large", `Part exceeds the ${MAX_PART_BYTES / MIB} MiB limit`));
}

/**
 * POST /api/control/uploads/multipart/start?filename=...&size=<bytes>
 * 初始化 R2 大文件分片上传任务。`size`（可选）是客户端声明的文件体积：声明超限立即拒绝，
 * 不发起任何 R2 multipart。它只是提前失败的便利——权威校验在分片累计与 complete 后的真实对象大小。
 */
export async function handleStartMultipartUpload(request: Request, url: URL, env: Env): Promise<Response> {
  const rawFilename = (url.searchParams.get("filename") ?? request.headers.get("x-filename") ?? "").trim();
  if (!rawFilename) {
    throw new HttpError(400, "filename_required", "filename parameter or X-Filename header is required");
  }

  const safeFilename = sanitizeFilename(rawFilename);
  const ext = getAudioExtension(safeFilename);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new HttpError(400, "invalid_extension", `Unsupported audio extension '${ext}'. Allowed: ${Array.from(ALLOWED_EXTENSIONS).join(", ")}`);
  }

  const declaredRaw = url.searchParams.get("size");
  if (declaredRaw !== null) {
    const declaredSize = Number(declaredRaw);
    if (!Number.isFinite(declaredSize) || declaredSize < 0) {
      throw new HttpError(400, "invalid_size", "size must be a non-negative number of bytes");
    }
    if (declaredSize > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, "file_too_large", `Audio file exceeds the ${capLabel} limit`);
    }
  }

  const contentType = request.headers.get("content-type") || "application/octet-stream";
  const uploadId = crypto.randomUUID();
  const key = `uploads/${uploadId}/${safeFilename}`;

  if (!env.storage.createMultipartUpload) throw new HttpError(500, "storage_error", "Multipart upload not supported");
  const multi = await env.storage.createMultipartUpload(key, {
    httpMetadata: { contentType },
    customMetadata: { upload_id: uploadId, original_name: rawFilename },
  });

  return json({
    upload_id: uploadId,
    r2_upload_id: multi.uploadId,
    key,
    filename: safeFilename,
  });
}

/**
 * PUT /api/control/uploads/multipart/:upload_id/parts/:part_number
 * 上传单个分片流（≤ 10 MiB）。
 *
 * 累计上限的推导：每片 ≤ MAX_PART_BYTES 且 part_number ≤ MAX_PARTS（= ceil(200 MiB / 10 MiB) = 20），
 * 所以任何分片组合的总量都不可能超过 200 MiB；最终对象大小仍会在 complete 时复核。
 */
export async function handleUploadPart(request: Request, uploadId: string, partNumberStr: string, env: Env): Promise<Response> {
  const partNumber = parseInt(partNumberStr, 10);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
    throw new HttpError(400, "invalid_part_number", `Part number must be an integer between 1 and ${MAX_PARTS} (audio is limited to ${capLabel})`);
  }

  const r2UploadId = (request.headers.get("x-r2-upload-id") ?? "").trim();
  const key = (request.headers.get("x-upload-key") ?? "").trim();
  if (!r2UploadId || !key) {
    throw new HttpError(400, "missing_multipart_headers", "X-R2-Upload-Id and X-Upload-Key headers are required");
  }

  if (!key.startsWith(`uploads/${uploadId}/`)) {
    throw new HttpError(400, "invalid_key", "Upload key does not match upload_id");
  }

  if (!request.body) {
    throw new HttpError(400, "empty_body", "Part upload request body must contain binary chunk");
  }

  const declared = declaredLength(request);
  if (declared !== null && declared > MAX_PART_BYTES) {
    throw new HttpError(413, "part_too_large", `Part size exceeds ${MAX_PART_BYTES / MIB} MiB limit`);
  }
  if (declared === 0) {
    throw new HttpError(400, "empty_body", "Part upload request body must contain binary chunk");
  }
  // 有 Content-Length：直接把原始 body（已知长度）交给 R2；否则缓冲这一片（≤ 10 MiB）再上传。
  const partBody = declared !== null ? request.body : await bufferPart(request.body);

  if (!env.storage.resumeMultipartUpload) throw new HttpError(500, "storage_error", "Multipart upload not supported");
  const multi = env.storage.resumeMultipartUpload(key, r2UploadId);
  try {
    const uploadedPart = await multi.uploadPart(partNumber, partBody);
    return json({
      partNumber: uploadedPart.partNumber,
      etag: uploadedPart.etag,
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error("Failed to upload multipart part:", err);
    throw new HttpError(500, "part_upload_failed", "Failed to upload part to R2");
  }
}

/**
 * POST /api/control/uploads/multipart/:upload_id/complete
 * 完成分片合并并确认文件。
 */
export async function handleCompleteMultipartUpload(request: Request, uploadId: string, env: Env): Promise<Response> {
  const body = await readJson<{ r2_upload_id?: string; key?: string; parts?: Array<{ partNumber: number; etag: string }> }>(request);
  const r2UploadId = (body.r2_upload_id ?? "").trim();
  const key = (body.key ?? "").trim();
  const parts = body.parts;

  if (!r2UploadId || !key || !Array.isArray(parts) || parts.length === 0) {
    throw new HttpError(400, "invalid_complete_payload", "r2_upload_id, key, and non-empty parts array are required");
  }

  if (parts.length > MAX_PARTS) {
    throw new HttpError(400, "too_many_parts", `Multipart upload cannot exceed ${MAX_PARTS} parts (audio is limited to ${capLabel})`);
  }

  if (!key.startsWith(`uploads/${uploadId}/`)) {
    throw new HttpError(400, "invalid_key", "Upload key does not match upload_id");
  }

  // 分片编号必须是 1..MAX_PARTS 内互不重复的整数（累计体积上限的一部分：不存在第 21 片）。
  const seen = new Set<number>();
  for (const part of parts) {
    if (!Number.isInteger(part?.partNumber) || part.partNumber < 1 || part.partNumber > MAX_PARTS || typeof part.etag !== "string" || !part.etag) {
      throw new HttpError(400, "invalid_part_number", `Part numbers must be integers between 1 and ${MAX_PARTS} with an etag`);
    }
    if (seen.has(part.partNumber)) {
      throw new HttpError(400, "duplicate_part_number", "Part numbers must be unique");
    }
    seen.add(part.partNumber);
  }

  const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  if (!env.storage.resumeMultipartUpload) throw new HttpError(500, "storage_error", "Multipart upload not supported");
  const multi = env.storage.resumeMultipartUpload(key, r2UploadId);

  try {
    const obj = await multi.complete(sortedParts);
    // 权威复核：以 R2 里真实组装出的对象大小为准，超限则销毁对象——不可能留下 >200 MiB 的合法上传。
    if (obj.size > MAX_UPLOAD_BYTES) {
      await env.storage.delete(key).catch(() => undefined);
      throw new HttpError(413, "file_too_large", `Assembled audio exceeds the ${capLabel} limit`);
    }
    return json({
      upload_id: uploadId,
      key,
      filename: sanitizeFilename(key),
      size: obj.size,
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error("Failed to complete multipart upload:", err);
    throw new HttpError(500, "multipart_complete_failed", "Failed to assemble multipart upload in R2");
  }
}

/**
 * POST /api/control/uploads/multipart/:upload_id/abort
 * 中止并清理未完成的分片。
 */
export async function handleAbortMultipartUpload(request: Request, uploadId: string, env: Env): Promise<Response> {
  const body = await readJson<{ r2_upload_id?: string; key?: string }>(request);
  const r2UploadId = (body.r2_upload_id ?? "").trim();
  const key = (body.key ?? "").trim();

  if (!r2UploadId || !key) {
    throw new HttpError(400, "invalid_abort_payload", "r2_upload_id and key are required");
  }

  if (!key.startsWith(`uploads/${uploadId}/`)) {
    throw new HttpError(400, "invalid_key", "Upload key does not match upload_id");
  }

  if (!env.storage.resumeMultipartUpload) throw new HttpError(500, "storage_error", "Multipart upload not supported");
  const multi = env.storage.resumeMultipartUpload(key, r2UploadId);
  try {
    await multi.abort();
    return json({ ok: true, aborted: true });
  } catch (err) {
    console.error("Failed to abort multipart upload:", err);
    throw new HttpError(500, "multipart_abort_failed", "Failed to abort multipart upload");
  }
}

/**
 * POST /api/control/uploads?filename=...
 * 接收客户端音频流（零 Worker 内存缓冲）直接流式写入 R2 uploads/<upload_id>/<safe_name>。
 */
export async function handleUploadAudio(request: Request, url: URL, env: Env): Promise<Response> {
  const rawFilename = (url.searchParams.get("filename") ?? request.headers.get("x-filename") ?? "").trim();
  if (!rawFilename) {
    throw new HttpError(400, "filename_required", "filename parameter or X-Filename header is required");
  }

  const safeFilename = sanitizeFilename(rawFilename);
  const ext = getAudioExtension(safeFilename);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new HttpError(400, "invalid_extension", `Unsupported audio extension '${ext}'. Allowed: ${Array.from(ALLOWED_EXTENSIONS).join(", ")}`);
  }

  if (!request.body) {
    throw new HttpError(400, "empty_body", "Request body must contain audio binary data");
  }
  const declared = declaredLength(request);
  if (declared === null) {
    throw new HttpError(411, "length_required", "Content-Length is required for single-request uploads (use the multipart upload API for streamed uploads)");
  }
  if (declared > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, "file_too_large", `Audio file exceeds the ${capLabel} limit`);
  }

  const contentType = request.headers.get("content-type") || "application/octet-stream";
  const uploadId = crypto.randomUUID();
  const key = `uploads/${uploadId}/${safeFilename}`;

  let stored: { size: number };
  try {
    stored = await env.storage.put(key, request.body, {
      httpMetadata: {
        contentType,
      },
      customMetadata: {
        upload_id: uploadId,
        original_name: rawFilename,
      },
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error("Failed to stream audio to storage:", err);
    throw new HttpError(500, "upload_failed", "Failed to write audio stream to storage");
  }

  // 权威复核：以存储里真实落地的对象大小为准（声明与实际不符时销毁对象）。
  if (stored.size > MAX_UPLOAD_BYTES) {
    await env.storage.delete(key).catch(() => undefined);
    throw new HttpError(413, "file_too_large", `Audio exceeds the ${capLabel} limit`);
  }

  return json({
    upload_id: uploadId,
    filename: safeFilename,
    original_name: rawFilename,
    size: stored.size,
    key,
  });
}

/**
 * 主动删除存储中的上传音频（raw checkpoint 成功持久化后立即调用）。
 */
export async function deleteUploadObjects(env: Env, uploadId: string): Promise<void> {
  if (!uploadId) return;
  const prefix = `uploads/${uploadId}/`;
  const listed = await env.storage.list({ prefix });
  for (const obj of listed.objects) {
    await env.storage.delete(obj.key).catch(() => undefined);
  }
}
