/**
 * 全局单调进度：Cloudflare 把转录服务上报的子阶段进度（fetching / preparing / transcribing，均为
 * 阶段内 0..100）映射为任务的全局百分比。转录服务不拥有全局进度状态机。
 *
 *   downloading（获取 / 准备音频） 0 – 25
 *   transcribing（转录）          25 – 65
 *   refining（精修）              65 – 95
 *   finalizing（保存正式稿）       95 – 100
 */
export const STAGE_PROGRESS_RANGES: Record<string, [number, number]> = {
  queued: [0, 0],
  downloading: [0, 25],
  transcribing: [25, 65],
  refining: [65, 95],
  finalizing: [95, 100],
  success: [100, 100],
};

/** global_progress = stage_base + local_progress * stage_span */
export function mapGlobalProgress(stage: string, localProgress: number): number {
  const range = STAGE_PROGRESS_RANGES[stage];
  if (!range) return Math.min(100, Math.max(0, Math.round(localProgress)));
  const [base, target] = range;
  const clampedLocal = Math.min(100, Math.max(0, localProgress));
  const span = target - base;
  return Math.min(100, Math.max(base, Math.round(base + (clampedLocal / 100) * span)));
}
