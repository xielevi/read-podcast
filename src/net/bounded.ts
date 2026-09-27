/**
 * 有界读取：逐块累计字节数，超过上限立即取消底层流并抛出调用方给出的错误（各调用方的错误类型不同：
 * HttpError / TranscriptionServiceError / 普通 Error）。绝不先把整个响应读进内存再判断大小。
 */

export async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  tooLarge: () => Error,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** 读取响应体：声明的 Content-Length 已超限时不读正文直接拒绝；否则按实际字节有界读取。 */
export async function readBoundedResponse(response: Response, maxBytes: number, tooLarge: () => Error): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw tooLarge();
  return readBoundedStream(response.body, maxBytes, tooLarge);
}

export async function readBoundedText(response: Response, maxBytes: number, tooLarge: () => Error): Promise<string> {
  return new TextDecoder().decode(await readBoundedResponse(response, maxBytes, tooLarge));
}
