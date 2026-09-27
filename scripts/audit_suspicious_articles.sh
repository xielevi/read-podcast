#!/usr/bin/env bash
# 历史伪稿风险只读审计（一次性检查，不删除任何数据）。
#
# 背景：曾发生真实事故——mlx_whisper 缺依赖时服务返回 stub transcript，
# Edge/旧 pipeline 据极短 raw + RSS summary 生成了虚构访谈并 commit 到 GitHub。
# 两篇已确认删除。本脚本从 D1 筛出高风险候选供人工抽查：
#   - 疑似特征 A：正式稿但 transcript_source != 'ai_refined'（旧管线产物，风险窗口）
#   - 疑似特征 B：精修失败标记（refinement_success != 1）却已 success
#   - 疑似特征 C：MLX strict 修复（PR #6，2026-09-19）之前的 success 任务
# 输出：候选清单（task id / 播客 / 单集 / 时间 / source / GitHub 路径）。
#
# 用法：bash scripts/audit_suspicious_articles.sh
# 只执行 SELECT，不写库、不删 R2/GitHub 任何对象。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 历史伪稿风险候选（只读） =="
wrangler d1 execute DB --remote --json --command "
  SELECT id, source_type, podcast_name, episode_title, status,
         transcript_source, refinement_success,
         created_at, completed_at, final_content_path
  FROM tasks
  WHERE status = 'success'
    AND (
      transcript_source IS NULL
      OR transcript_source != 'ai_refined'
      OR refinement_success IS NULL
      OR refinement_success != 1
      OR completed_at < '2026-09-19'
    )
  ORDER BY completed_at ASC
" | python3 -c "
import json, sys
data = json.load(sys.stdin)
rows = [r for res in data for r in res.get('results', [])]
if not rows:
    print('未发现候选：所有 success 任务均为 ai_refined 且在 strict 修复之后。')
else:
    print(f'发现 {len(rows)} 个候选（需人工抽查 GitHub 稿件特征）：')
    for r in rows:
        print('-'*80)
        for k in ('id', 'source_type', 'podcast_name', 'episode_title', 'transcript_source',
                  'refinement_success', 'created_at', 'completed_at', 'final_content_path'):
            print(f'  {k}: {r.get(k)}')
"
echo
echo "提示：候选稿件需人工核对其正文是否具备真实访谈特征（时间线/对话连续性），"
echo "并对照 GitHub writing 仓库的 commit 时间与旧 MLX strict 修复窗口。本脚本不执行任何删除。"
