/**
 * 本地 SQLite 平台适配器：基于 node:sqlite (DatabaseSync) 实现 Database / Statement 接口。
 * 遵循与 Cloudflare D1 相同的外键约束、WAL 模式和迁移执行逻辑。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Database, Statement, StatementResult } from "../types";

export class SqliteStatementAdapter implements Statement {
  private params: unknown[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly rawStmt?: StatementSync,
  ) {}

  bind(...values: unknown[]): Statement {
    const next = new SqliteStatementAdapter(this.db, this.sql, this.rawStmt);
    next.params = values.map(v => (v === undefined ? null : v));
    return next;
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.rawStmt ?? this.db.prepare(this.sql);
    const row = stmt.get(...(this.params as never[])) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName) return (row[colName] ?? null) as T;
    return { ...row } as T;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const stmt = this.rawStmt ?? this.db.prepare(this.sql);
    const rows = stmt.all(...(this.params as never[])) as Record<string, unknown>[];
    return { results: rows.map(r => ({ ...r })) as T[] };
  }

  async run<T = Record<string, unknown>>(): Promise<{ meta: { changes?: number }; success?: boolean; results?: T[] }> {
    const stmt = this.rawStmt ?? this.db.prepare(this.sql);
    const res = stmt.run(...(this.params as never[]));
    return { meta: { changes: Number(res.changes) }, success: true };
  }

  batchResult(): StatementResult {
    const stmt = this.rawStmt ?? this.db.prepare(this.sql);
    if (/^\s*(SELECT|WITH)\b/i.test(this.sql)) {
      const rows = stmt.all(...(this.params as never[])) as Record<string, unknown>[];
      return { results: rows.map(r => ({ ...r })), meta: { changes: 0 }, success: true };
    }
    const res = stmt.run(...(this.params as never[]));
    return { results: [], meta: { changes: Number(res.changes) }, success: true };
  }
}

export function createSqliteDatabase(raw: DatabaseSync): Database {
  return {
    prepare(query: string): Statement {
      return new SqliteStatementAdapter(raw, query, raw.prepare(query));
    },
    async batch<T = StatementResult>(statements: Statement[]): Promise<T[]> {
      raw.exec("BEGIN");
      try {
        const results: StatementResult[] = [];
        for (const stmt of statements) {
          if (stmt instanceof SqliteStatementAdapter) {
            results.push(stmt.batchResult());
          } else {
            const res = await stmt.run();
            results.push({ results: res.results ?? [], meta: res.meta, success: res.success });
          }
        }
        raw.exec("COMMIT");
        return results as T[];
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

export function initWorkflowTables(raw: DatabaseSync): void {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS _workflow_instances (
      id TEXT PRIMARY KEY,
      params TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS _workflow_checkpoints (
      instance_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      output TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (instance_id, step_name)
    );
  `);
}

export function applyLocalMigrations(raw: DatabaseSync, migrationsDir: string): string[] {
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec(`
    CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const files = readdirSync(migrationsDir)
    .filter(file => file.endsWith(".sql"))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    const existing = raw.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").get(file);
    if (existing) continue;

    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    raw.exec("BEGIN");
    try {
      raw.exec(sql);
      raw.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(file);
      raw.exec("COMMIT");
      applied.push(file);
    } catch (err) {
      raw.exec("ROLLBACK");
      throw new Error(`Failed to apply migration ${file}: ${(err as Error).message}`);
    }
  }

  initWorkflowTables(raw);
  return applied;
}
