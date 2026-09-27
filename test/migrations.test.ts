/**
 * 0015 迁移：把 tasks 的状态枚举从 worker-owned 词汇迁到 Cloudflare-owned 词汇，
 * 并在重建表时保住已成稿的 articles、把升级时的 active task 安全地重新排队。
 *
 * 全部在真实 SQLite 上按生产顺序执行 migrations/*.sql（foreign_keys = ON，与 D1 一致）。
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { TASK_COLUMNS } from "../src/db";
import { migrate, migrationFiles } from "./helpers/sqlite-d1";

const UP_TO_0014 = "0014_finalization_owner.sql";

function legacyDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db, { upTo: UP_TO_0014 });
  return db;
}

interface LegacyTask {
  id: string;
  status: string;
  episode?: string | null;
  cancel_requested?: number;
  completion_claimed?: number;
  raw_object_key?: string | null;
  refine_workflow_id?: string | null;
  attempt?: string;
  progress?: number;
  error_code?: string | null;
  message?: string;
  finalization_owner?: string | null;
}

function insertLegacyTask(db: DatabaseSync, task: LegacyTask): void {
  db.prepare(`INSERT INTO tasks
    (id, episode_id, source_type, podcast_name, episode_title, audio_url, status, progress, message,
     current_attempt_id, cancel_requested, completion_claimed, raw_object_key, refine_workflow_id, error_code,
     finalization_owner, updated_at)
    VALUES (?, ?, 'rss', 'Show', ?, 'https://cdn.example.com/a.mp3', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`)
    .run(
      task.id,
      task.episode ?? null,
      `Episode ${task.id}`,
      task.status,
      task.progress ?? 30,
      task.message ?? "old message",
      task.attempt ?? `old-attempt-${task.id}`,
      task.cancel_requested ?? 0,
      task.completion_claimed ?? 0,
      task.raw_object_key ?? null,
      task.refine_workflow_id ?? null,
      task.error_code ?? null,
      task.finalization_owner ?? null,
    );
}

function migrate0015(db: DatabaseSync): void {
  migrate(db, { from: "0015_cloudflare_owned_transcription.sql", upTo: "0015_cloudflare_owned_transcription.sql" });
}

function row(db: DatabaseSync, id: string): Record<string, unknown> {
  return { ...(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown>) };
}

describe("0015_cloudflare_owned_transcription", () => {
  it("0015 迁移文件存在，并且文件名与内容一致", () => {
    expect(migrationFiles()).toContain("0015_cloudflare_owned_transcription.sql");
  });

  it("重建 tasks 不会级联删除已成稿的 articles", () => {
    const db = legacyDb();
    insertLegacyTask(db, { id: "t-success", status: "success", progress: 100 });
    db.prepare(`INSERT INTO articles (task_id, title, podcast_name, content_path, commit_sha) VALUES ('t-success', 'A', 'Show', 'podcasts/transcripts/a.md', 'abc123')`).run();

    migrate0015(db);

    const articles = db.prepare("SELECT task_id, title, content_path, commit_sha FROM articles").all();
    expect(articles).toEqual([{ task_id: "t-success", title: "A", content_path: "podcasts/transcripts/a.md", commit_sha: "abc123" }]);
    // 外键仍然有效：articles 引用新的 tasks 表
    expect(() => db.prepare("INSERT INTO articles (task_id, title, content_path, commit_sha) VALUES ('ghost', 'x', 'p', 'c')").run()).toThrow();
    // 新 tasks 上的级联删除依旧生效
    db.prepare("DELETE FROM tasks WHERE id = 't-success'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM articles").get()).toEqual({ n: 0 });
  });

  it("success / error / cancelled 原样保留（含 updated_at 与 error_code）", () => {
    const db = legacyDb();
    insertLegacyTask(db, { id: "t-ok", status: "success", progress: 100 });
    insertLegacyTask(db, { id: "t-err", status: "error", error_code: "refine_quality_gate", message: "门禁失败", raw_object_key: "raw/t-err/a.txt", attempt: "att-err" });
    insertLegacyTask(db, { id: "t-can", status: "cancelled", cancel_requested: 1, attempt: "att-can" });

    migrate0015(db);

    expect(row(db, "t-ok")).toMatchObject({ status: "success", progress: 100, updated_at: "2026-01-01T00:00:00.000Z" });
    expect(row(db, "t-err")).toMatchObject({
      status: "error",
      error_code: "refine_quality_gate",
      message: "门禁失败",
      raw_object_key: "raw/t-err/a.txt",
      current_attempt_id: "att-err",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    expect(row(db, "t-can")).toMatchObject({ status: "cancelled", cancel_requested: 1 });
  });

  it.each([
    ["waiting_worker", null, null],
    ["downloading", null, null],
    ["transcribing", null, null],
    ["transcribing", "raw/t/old.txt", null],
    ["refining", "raw/t/old.txt", "refine-t-old"],
  ])("升级时的 active task（%s，raw=%s，workflow=%s）→ queued：轮换 attempt、清空 workflow，raw 保留", (status, rawKey, workflow) => {
    const db = legacyDb();
    insertLegacyTask(db, { id: "t", status, raw_object_key: rawKey, refine_workflow_id: workflow, attempt: "old-attempt", progress: 70 });

    migrate0015(db);

    const task = row(db, "t");
    expect(task.status).toBe("queued");
    expect(task.progress).toBe(0);
    expect(task.workflow_id).toBeNull();
    expect(task.provider_request_id).toBeNull();
    expect(task.raw_object_key).toBe(rawKey);
    expect(task.error_code).toBeNull();
    expect(task.current_attempt_id).not.toBe("old-attempt");
    expect(String(task.current_attempt_id)).toMatch(/^[0-9a-f]{32}$/);
    expect(String(task.message)).toContain("重新排队");
  });

  it("多个 active task 各自获得不同的新 attempt", () => {
    const db = legacyDb();
    insertLegacyTask(db, { id: "a", status: "waiting_worker" });
    insertLegacyTask(db, { id: "b", status: "downloading" });
    migrate0015(db);
    expect(row(db, "a").current_attempt_id).not.toBe(row(db, "b").current_attempt_id);
  });

  it("带有挂起取消意图的 active task 直接收敛为 cancelled（不再重跑）", () => {
    const db = legacyDb();
    insertLegacyTask(db, { id: "t", status: "transcribing", cancel_requested: 1 });
    migrate0015(db);
    expect(row(db, "t")).toMatchObject({ status: "cancelled", message: "任务已取消" });
    expect(row(db, "t").completed_at).toBeTruthy();
  });

  it("成稿提交中（completion_claimed = 1）保持原样，由 stale-claim sweep 收敛", () => {
    const db = legacyDb();
    insertLegacyTask(db, {
      id: "t", status: "refining", completion_claimed: 1, refine_workflow_id: "refine-t-a", finalization_owner: "refine-t-a",
      raw_object_key: "raw/t/a.txt", attempt: "att", progress: 96,
    });
    migrate0015(db);
    expect(row(db, "t")).toMatchObject({
      status: "refining",
      completion_claimed: 1,
      workflow_id: "refine-t-a",
      finalization_owner: "refine-t-a",
      current_attempt_id: "att",
      progress: 96,
    });
  });

  it("新的状态枚举由 CHECK 约束强制：旧词汇不再合法", () => {
    const db = legacyDb();
    migrate0015(db);
    const insert = (status: string) =>
      db.prepare("INSERT INTO tasks (id, source_type, episode_title, status) VALUES (?, 'rss', 't', ?)").run(`id-${status}`, status);
    for (const ok of ["queued", "transcribing", "refining", "success", "error", "cancelled"]) expect(() => insert(ok)).not.toThrow();
    for (const bad of ["waiting_worker", "downloading", "pending"]) expect(() => insert(bad)).toThrow();
  });

  it("transcription_phase 只接受转录服务的子阶段", () => {
    const db = legacyDb();
    migrate0015(db);
    const set = (phase: string | null) =>
      db.prepare("INSERT INTO tasks (id, source_type, episode_title, status, transcription_phase) VALUES (?, 'rss', 't', 'transcribing', ?)").run(`p-${phase}`, phase);
    for (const ok of ["fetching", "preparing", "transcribing", null]) expect(() => set(ok)).not.toThrow();
    expect(() => set("mac_downloading")).toThrow();
  });

  it("活跃态部分唯一索引使用新枚举：同一 episode 只能有一个活跃任务", () => {
    const db = legacyDb();
    db.prepare("INSERT INTO subscriptions (name, rss_url) VALUES ('Show', 'https://x/rss')").run();
    db.prepare("INSERT INTO episodes (id, subscription_id, podcast_name, title, audio_url) VALUES ('ep1', 1, 'Show', 'E', 'https://x/a.mp3')").run();
    migrate0015(db);
    const add = (id: string, status: string) =>
      db.prepare("INSERT INTO tasks (id, episode_id, source_type, episode_title, status) VALUES (?, 'ep1', 'rss', 'E', ?)").run(id, status);
    add("first", "queued");
    expect(() => add("second", "transcribing")).toThrow(/UNIQUE/);
    db.prepare("UPDATE tasks SET status = 'error' WHERE id = 'first'").run();
    expect(() => add("third", "queued")).not.toThrow();
  });

  it("升级迁移可在已升级库上重复执行安全性：对全新库整体应用不报错，且列集合符合预期", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);
    const columns = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(c => c.name);
    expect(columns).toEqual(expect.arrayContaining(["provider_request_id", "transcription_phase", "raw_object_key", "current_attempt_id"]));
    expect(columns).not.toContain("refine_workflow_id");
    expect(columns).not.toContain("workflow_id");
    expect(columns).not.toContain("completion_claimed");
    expect(columns).not.toContain("finalization_owner");
  });

  it("升级不改动 episodes / 订阅 / refiner 配置等无关表", () => {
    const db = legacyDb();
    db.prepare("INSERT INTO subscriptions (name, rss_url) VALUES ('Show', 'https://x/rss')").run();
    db.prepare("INSERT INTO episodes (id, subscription_id, podcast_name, title, audio_url) VALUES ('ep1', 1, 'Show', 'E', 'https://x/a.mp3')").run();
    db.prepare("INSERT INTO read_state (podcast_name, episode_title) VALUES ('Show', 'E')").run();
    migrate0015(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM episodes").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM subscriptions").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM read_state").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT api_base FROM refiner_settings WHERE id = 1").get()).toBeTruthy();
  });
});

describe("0016_simplify_execution_topology", () => {
  function dbUpTo0015(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db, { upTo: "0015_cloudflare_owned_transcription.sql" });
    return db;
  }

  function migrate0016(db: DatabaseSync): void {
    migrate(db, { from: "0016_simplify_execution_topology.sql", upTo: "0016_simplify_execution_topology.sql" });
  }

  it("迁移文件名与内容一致", () => {
    expect(migrationFiles()).toContain("0016_simplify_execution_topology.sql");
  });

  it("重建 tasks 不会级联删除已成稿的 articles，外键依然有效", () => {
    const db = dbUpTo0015();
    db.prepare(`INSERT INTO tasks (id, source_type, episode_title, status) VALUES ('t-1', 'rss', 'T1', 'success')`).run();
    db.prepare(`INSERT INTO articles (task_id, title, podcast_name, content_path, commit_sha)
      VALUES ('t-1', 'T1', 'P', 'podcasts/transcripts/t1.md', 'sha-1')`).run();

    migrate0016(db);

    const articles = db.prepare("SELECT task_id, title, content_path, commit_sha FROM articles").all();
    expect(articles).toEqual([{ task_id: "t-1", title: "T1", content_path: "podcasts/transcripts/t1.md", commit_sha: "sha-1" }]);
    // 引用不存在 task 仍然触发外键约束报错
    expect(() => db.prepare("INSERT INTO articles (task_id, title, content_path, commit_sha) VALUES ('ghost', 'x', 'p', 'c')").run()).toThrow();
  });

  it("删除 workflow_id, completion_claimed, finalization_owner 列", () => {
    const db = dbUpTo0015();
    migrate0016(db);
    const columns = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(c => c.name);
    expect(columns).not.toContain("workflow_id");
    expect(columns).not.toContain("completion_claimed");
    expect(columns).not.toContain("finalization_owner");
    expect(columns).toEqual(expect.arrayContaining(["current_attempt_id", "cancel_requested", "raw_object_key", "provider_request_id"]));
  });

  it("已有 completion_claimed = 1 且非终态的任务转为 status = 'finalizing'", () => {
    const db = dbUpTo0015();
    db.prepare(`INSERT INTO tasks (id, source_type, episode_title, status, completion_claimed, progress)
      VALUES ('t-fin', 'rss', 'T-Fin', 'refining', 1, 95)`).run();
    db.prepare(`INSERT INTO tasks (id, source_type, episode_title, status, completion_claimed, progress)
      VALUES ('t-succ', 'rss', 'T-Succ', 'success', 0, 100)`).run();
    db.prepare(`INSERT INTO tasks (id, source_type, episode_title, status, completion_claimed, progress)
      VALUES ('t-err', 'rss', 'T-Err', 'error', 0, 80)`).run();

    migrate0016(db);

    const fin = row(db, "t-fin");
    expect(fin.status).toBe("finalizing");
    expect(fin.progress).toBe(95);

    const succ = row(db, "t-succ");
    expect(succ.status).toBe("success");

    const err = row(db, "t-err");
    expect(err.status).toBe("error");
  });

  it("状态枚举 CHECK 约束允许 'finalizing'，阻止无效枚举", () => {
    const db = dbUpTo0015();
    migrate0016(db);
    const insert = (status: string) =>
      db.prepare("INSERT INTO tasks (id, source_type, episode_title, status) VALUES (?, 'rss', 't', ?)").run(`id-${status}`, status);
    for (const ok of ["queued", "transcribing", "refining", "finalizing", "success", "error", "cancelled"]) {
      expect(() => insert(ok)).not.toThrow();
    }
    for (const bad of ["waiting_worker", "downloading", "pending", "other"]) {
      expect(() => insert(bad)).toThrow();
    }
  });

  it("活跃态唯一索引包含 'finalizing'：同一 episode 处于 finalizing 时不能重复创建任务", () => {
    const db = dbUpTo0015();
    db.prepare("INSERT INTO subscriptions (name, rss_url) VALUES ('Show', 'https://x/rss')").run();
    db.prepare("INSERT INTO episodes (id, subscription_id, podcast_name, title, audio_url) VALUES ('ep1', 1, 'Show', 'E', 'https://x/a.mp3')").run();
    migrate0016(db);

    db.prepare("INSERT INTO tasks (id, episode_id, source_type, episode_title, status) VALUES ('first', 'ep1', 'rss', 'E', 'finalizing')").run();
    expect(() =>
      db.prepare("INSERT INTO tasks (id, episode_id, source_type, episode_title, status) VALUES ('second', 'ep1', 'rss', 'E', 'queued')").run(),
    ).toThrow(/UNIQUE/);
  });
});

describe("0017_ui_preferences", () => {
  function dbUpTo0016(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db, { upTo: "0016_simplify_execution_topology.sql" });
    return db;
  }

  function migrate0017(db: DatabaseSync): void {
    migrate(db, { from: "0017_ui_preferences.sql", upTo: "0017_ui_preferences.sql" });
  }

  it("迁移文件存在", () => {
    expect(migrationFiles()).toContain("0017_ui_preferences.sql");
  });

  it("创建 ui_preferences 单行表并初始化默认值", () => {
    const db = dbUpTo0016();
    migrate0017(db);

    const row = db.prepare("SELECT * FROM ui_preferences WHERE id = 1").get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.app_theme).toBe("auto");
    expect(row.reader_theme).toBe("follow");
    expect(row.font_preset).toBe("classical");
    expect(row.font_size).toBe(19);
    expect(row.line_height).toBe("normal");
    expect(row.margin_width).toBe("normal");
    expect(row.updated_at).toBeTruthy();
  });

  it("CHECK 约束限制 id=1 且阻止非法枚举和字号", () => {
    const db = dbUpTo0016();
    migrate0017(db);

    expect(() =>
      db.prepare("INSERT INTO ui_preferences (id) VALUES (2)").run()
    ).toThrow();

    expect(() =>
      db.prepare("UPDATE ui_preferences SET app_theme = 'neon' WHERE id = 1").run()
    ).toThrow();

    expect(() =>
      db.prepare("UPDATE ui_preferences SET font_size = 5 WHERE id = 1").run()
    ).toThrow();
  });
});

describe("0018_refinement_editorial_density", () => {
  function dbUpTo0017(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db, { upTo: "0017_ui_preferences.sql" });
    return db;
  }

  function migrate0018(db: DatabaseSync): void {
    migrate(db, { from: "0018_refinement_editorial_density.sql", upTo: "0018_refinement_editorial_density.sql" });
  }

  it("迁移文件存在", () => {
    expect(migrationFiles()).toContain("0018_refinement_editorial_density.sql");
  });

  it("历史默认 0.90 迁移到 0.70", () => {
    const db = dbUpTo0017();
    expect((db.prepare("SELECT min_output_ratio FROM refiner_settings WHERE id = 1").get() as { min_output_ratio: number }).min_output_ratio).toBe(0.9);

    migrate0018(db);

    expect((db.prepare("SELECT min_output_ratio FROM refiner_settings WHERE id = 1").get() as { min_output_ratio: number }).min_output_ratio).toBe(0.7);
  });

  it("非 0.90 的自定义阈值不被覆盖", () => {
    const db = dbUpTo0017();
    db.prepare("UPDATE refiner_settings SET min_output_ratio = 0.82 WHERE id = 1").run();

    migrate0018(db);

    expect((db.prepare("SELECT min_output_ratio FROM refiner_settings WHERE id = 1").get() as { min_output_ratio: number }).min_output_ratio).toBe(0.82);
  });
});

describe("0019_episode_page_indexes", () => {
  it("单集分页的关联与时间线排序走索引，不扫描 articles、不对整张 episodes 排序", () => {
    expect(migrationFiles()).toContain("0019_episode_page_indexes.sql");
    const db = new DatabaseSync(":memory:");
    migrate(db);
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(row => row.detail).join(" | ");

    const timeline = plan("SELECT e.id FROM episodes e ORDER BY (e.published_date GLOB '[0-9]*') DESC, e.published_date DESC, e.id LIMIT 10");
    expect(timeline).toContain("idx_episodes_timeline");
    expect(timeline).not.toContain("TEMP B-TREE");

    const byTitle = plan("SELECT 1 FROM episodes e WHERE EXISTS (SELECT 1 FROM articles a WHERE a.podcast_name = e.podcast_name AND a.title = e.title)");
    expect(byTitle).toContain("idx_articles_podcast_title");
  });
});

describe("0020_read_state_stable_ids", () => {
  function dbUpTo0019(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db, { upTo: "0019_episode_page_indexes.sql" });
    return db;
  }

  it("迁移文件存在", () => {
    expect(migrationFiles()).toContain("0020_read_state_stable_ids.sql");
  });

  it("旧的「节目名 + 标题」已读迁移为 episode_id（RSS）/ task_id（导入音频）；对不上的丢弃", () => {
    const db = dbUpTo0019();
    db.exec(`
      INSERT INTO subscriptions (id, name, rss_url) VALUES (1, 'P', 'https://x');
      INSERT INTO episodes (id, subscription_id, podcast_name, title, audio_url, source_id) VALUES ('1:a', 1, 'P', 'A', 'u', 'a'), ('1:b', 1, 'P', 'B', 'u', 'b');
      INSERT INTO tasks (id, episode_id, source_type, podcast_name, episode_title, status) VALUES ('t1', '1:a', 'rss', 'P', 'A', 'success'), ('t2', NULL, 'upload', '本地音频', 'U', 'success');
      INSERT INTO articles (task_id, episode_id, title, podcast_name, content_path, commit_sha) VALUES ('t1', '1:a', 'A', 'P', 'p', 's'), ('t2', NULL, 'U', '本地音频', 'q', 's');
      INSERT INTO read_state (podcast_name, episode_title, read_at) VALUES ('P', 'A', '2026-01-01T00:00:00.000Z'), ('P', 'B', '2026-01-02T00:00:00.000Z'), ('本地音频', 'U', '2026-01-03T00:00:00.000Z'), ('已删除的节目', 'X', '2026-01-04T00:00:00.000Z');
    `);
    migrate(db, { from: "0020_read_state_stable_ids.sql", upTo: "0020_read_state_stable_ids.sql" });
    expect(db.prepare("SELECT episode_id, task_id, read_at FROM read_state ORDER BY read_at").all().map(row => ({ ...row }))).toEqual([
      { episode_id: "1:a", task_id: null, read_at: "2026-01-01T00:00:00.000Z" },
      { episode_id: "1:b", task_id: null, read_at: "2026-01-02T00:00:00.000Z" },
      { episode_id: null, task_id: "t2", read_at: "2026-01-03T00:00:00.000Z" },
    ]);
  });

  it("约束：episode_id 与 task_id 恰好一个有值，且各自唯一", () => {
    const db = dbUpTo0019();
    migrate(db, { from: "0020_read_state_stable_ids.sql", upTo: "0020_read_state_stable_ids.sql" });
    expect(() => db.prepare("INSERT INTO read_state (episode_id, task_id) VALUES (NULL, NULL)").run()).toThrow();
    expect(() => db.prepare("INSERT INTO read_state (episode_id, task_id) VALUES ('1:a', 't')").run()).toThrow();
    db.prepare("INSERT INTO read_state (episode_id) VALUES ('1:a')").run();
    expect(() => db.prepare("INSERT INTO read_state (episode_id) VALUES ('1:a')").run()).toThrow();
  });
});

describe("0021_drop_unused_columns", () => {
  const columns = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name);

  it("是最新一条迁移；删掉无人读写的列与索引，数据保留", () => {
    expect(migrationFiles().at(-1)).toBe("0021_drop_unused_columns.sql");
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db, { upTo: "0020_read_state_stable_ids.sql" });
    db.exec(`
      INSERT INTO subscriptions (id, name, rss_url) VALUES (1, 'P', 'https://x');
      INSERT INTO episodes (id, subscription_id, podcast_name, title, audio_url, source_id, published_at, published_date) VALUES ('1:a', 1, 'P', 'A', 'u', 'a', '20260101', '20260101');
      INSERT INTO tasks (id, episode_id, source_type, podcast_name, episode_title, status, raw_content_path) VALUES ('t1', '1:a', 'rss', 'P', 'A', 'success', 'old/path.txt');
    `);
    migrate(db, { from: "0021_drop_unused_columns.sql", upTo: "0021_drop_unused_columns.sql" });

    expect(columns(db, "episodes")).not.toContain("published_at");
    expect(columns(db, "episodes")).not.toContain("artwork_url");
    expect(columns(db, "tasks")).not.toContain("raw_content_path");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_episodes_published'").get()).toBeUndefined();
    expect(db.prepare("SELECT id, published_date FROM episodes").get()).toEqual({ id: "1:a", published_date: "20260101" });
    expect(db.prepare("SELECT id, status FROM tasks").get()).toEqual({ id: "t1", status: "success" });
  });

  it("TaskRow 与 tasks 表 schema 一一对应", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    expect([...columns(db, "tasks")].sort()).toEqual([...TASK_COLUMNS].sort());
  });
});
