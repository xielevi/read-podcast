import type { makeCloud } from "./cloud";

/** 全部持久化 / 外部状态的快照：D1 每一张表 + R2 + Workflow 实例 + 外部副作用计数。 */
export function stateSnapshot(cloud: ReturnType<typeof makeCloud>) {
  const db = cloud.d1.raw;
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
  return {
    d1: Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()])),
    r2: [...(cloud.r2 as unknown as { objects: Map<string, unknown> }).objects.keys()].sort(),
    workflows: [...cloud.workflow.instances.keys()].sort(),
    service: [...cloud.service.log],
    llmCalls: cloud.externals.llmCalls,
    commits: cloud.externals.github.commits,
  };
}
