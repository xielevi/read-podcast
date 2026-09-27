import type { Env } from "./types";

/**
 * Whisper 原始转录的 R2 checkpoint。
 *
 * 键：`raw/<taskId>/<attemptId>.txt`。生命周期 7 天由桶上的 lifecycle 规则负责
 * （见 docs/ARCHITECTURE.md）；R2 是原始转录的唯一 durable 副本，**不入 GitHub**。
 *
 * raw 由 ProcessingWorkflow 的 `persist-raw-N` step 从转录服务取回后写入（见
 * workflows/transcription.ts），不再有任何外部节点直接向 Cloudflare 推送 raw 的入口。
 * R2 key 随 (task, attempt) 确定：同一 attempt 的重复写入是幂等覆盖，永远不会出现「两份 raw」。
 * raw 一旦落库，任何重试都直接进入精修，不再触发转录。
 */

export function rawPrefix(taskId: string): string {
  return `raw/${encodeURIComponent(taskId)}/`;
}

export function rawObjectKey(taskId: string, attemptId: string): string {
  return `${rawPrefix(taskId)}${encodeURIComponent(attemptId)}.txt`;
}

/**
 * 该任务是否已有可复用的 R2 raw（raw_object_key 优先，其次扫描 raw/ 前缀取最新）。
 * 存在 → 任何重试都不重新转录，直接精修。
 */
export async function resolveExistingRawKey(env: Env, taskId: string, rawObjectKeyHint: string | null): Promise<string | null> {
  if (rawObjectKeyHint) {
    const object = await env.storage.get(rawObjectKeyHint);
    if (object) return rawObjectKeyHint;
  }
  const listing = await env.storage.list({ prefix: rawPrefix(taskId) });
  let latest: { key: string; uploaded: number } | null = null;
  for (const object of listing.objects) {
    const uploaded = object.uploaded ? object.uploaded.getTime() : 0;
    if (!latest || uploaded >= latest.uploaded) latest = { key: object.key, uploaded };
  }
  return latest?.key ?? null;
}

/** 删除任务记录 / 转录不可用时，清理其所有 R2 原始转录（best-effort；lifecycle 也会兜底）。 */
export async function purgeRaw(env: Env, id: string): Promise<void> {
  const listing = await env.storage.list({ prefix: rawPrefix(id) });
  await Promise.all(listing.objects.map(object => env.storage.delete(object.key)));
}
