/**
 * 基于真实 SQLite（node:sqlite）的 D1 等价替身。
 *
 * 用真实 SQL 语义（CHECK / 外键 / 部分唯一索引 / CAS 的 changes 计数）代替字符串匹配式 mock：
 * 编排层的 CAS 守卫、迁移的数据保全都只有在真实 SQL 引擎上才有说服力。
 * 迁移文件按生产顺序原样执行（migrations/*.sql）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith(".sql"))
    .sort();
}

/** 运行 `upTo`（含）之前的迁移；不传则全部。 */
export function migrate(db: DatabaseSync, options: { upTo?: string; from?: string } = {}): void {
  for (const file of migrationFiles()) {
    if (options.from && file < options.from) continue;
    if (options.upTo && file > options.upTo) break;
    db.exec(readFileSync(new URL(file, MIGRATIONS_DIR), "utf-8"));
  }
}

export interface SqliteD1 {
  raw: DatabaseSync;
  prepare(sql: string): SqliteStatement;
  batch(statements: SqliteStatement[]): Promise<unknown[]>;
}

export class SqliteStatement {
  private params: unknown[] = [];
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...params: unknown[]): SqliteStatement {
    const next = new SqliteStatement(this.db, this.sql);
    next.params = params.map(value => (value === undefined ? null : value));
    return next;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.params as never[]));
    return (row ? { ...row } : null) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const rows = this.db.prepare(this.sql).all(...(this.params as never[]));
    return { results: rows.map(row => ({ ...row })) as T[] };
  }

  async run(): Promise<{ meta: { changes: number }; success: true }> {
    const result = this.db.prepare(this.sql).run(...(this.params as never[]));
    return { meta: { changes: Number(result.changes) }, success: true };
  }

  /** 同步执行（batch 在一个事务里逐条执行，中间不能让出事件循环，否则并发请求会嵌套 BEGIN）。 */
  batchResult(): { results: Record<string, unknown>[]; meta: { changes: number }; success: true } {
    const statement = this.db.prepare(this.sql);
    if (/^\s*(SELECT|WITH)\b/i.test(this.sql)) {
      const rows = statement.all(...(this.params as never[]));
      return { results: rows.map(row => ({ ...row })), meta: { changes: 0 }, success: true };
    }
    const result = statement.run(...(this.params as never[]));
    return { results: [], meta: { changes: Number(result.changes) }, success: true };
  }
}

/** 全新数据库：外键开启（与 D1 一致），并应用全部迁移。 */
export function createD1(options: { migrate?: boolean } = {}): SqliteD1 {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON;");
  if (options.migrate !== false) migrate(raw);
  return {
    raw,
    prepare: (sql: string) => new SqliteStatement(raw, sql),
    async batch(statements: SqliteStatement[]) {
      raw.exec("BEGIN");
      try {
        const results = [];
        // 与 D1 一致：读语句返回 results，写语句返回 meta.changes
        for (const statement of statements) results.push(statement.batchResult());
        raw.exec("COMMIT");
        return results;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
