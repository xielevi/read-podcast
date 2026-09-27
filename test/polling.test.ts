import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 任务轮询：从 public/js/40-tasks.js 抽出真实的 createTaskPoller（不是复制的逻辑），注入假的请求 / 定时器 / 可见性。
 */
const source = readFileSync(new URL("../public/js/40-tasks.js", import.meta.url), "utf-8");
const start = source.indexOf("function createTaskPoller(options) {");
let end = start;
for (let i = source.indexOf("{", start), depth = 0; i < source.length; i += 1) {
  if (source[i] === "{") depth += 1;
  if (source[i] === "}" && --depth === 0) {
    end = i + 1;
    break;
  }
}
const createTaskPoller = new Function(`${source.slice(start, end)}; return createTaskPoller;`)() as (options: unknown) => {
  watch(id: string): void;
  unwatch(id?: string): void;
  watchedIds(): string[];
  wake(): void;
};

type Task = { id: string; status: string; stage: string; progress_pct: number; message: string };

function harness(initial: Task[]) {
  let active = initial;
  let hidden = false;
  const requests: number[] = [];
  const updates: string[] = [];
  const finished: string[] = [];
  const poller = createTaskPoller({
    fetchActive: async () => {
      requests.push(Date.now());
      return active;
    },
    onUpdate: (task: Task) => updates.push(`${task.id}:${task.progress_pct}`),
    onFinished: (id: string) => finished.push(id),
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    isHidden: () => hidden,
  });
  return {
    poller,
    requests,
    updates,
    finished,
    setActive: (tasks: Task[]) => { active = tasks; },
    setHidden: (value: boolean) => { hidden = value; },
  };
}

const running = (id: string, progress = 10): Task => ({ id, status: "running", stage: "transcribing", progress_pct: progress, message: "" });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createTaskPoller：一个轮询器盯住所有进行中的任务", () => {
  it("没有盯着的任务就不发任何请求", async () => {
    const h = harness([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.requests).toEqual([]);
  });

  it("多个任务共用一个请求；重复 watch 不产生第二个定时器", async () => {
    const h = harness([running("a"), running("b"), running("c")]);
    h.poller.watch("a");
    h.poller.watch("b");
    h.poller.watch("a");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.requests).toHaveLength(1);
    expect(h.updates.sort()).toEqual(["a:10", "b:10"]);
  });

  it("没有变化就退避 5s → 7.5s → 11.25s → 15s 封顶；一有变化立刻回到 5s", async () => {
    const h = harness([running("a")]);
    h.poller.watch("a");
    await vi.advanceTimersByTimeAsync(5_000); // 第 1 轮：首次看到 = 变化
    await vi.advanceTimersByTimeAsync(5_000); // 第 2 轮：无变化 → 下次 7.5s
    await vi.advanceTimersByTimeAsync(7_500);
    await vi.advanceTimersByTimeAsync(11_250);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.requests).toEqual([5_000, 10_000, 17_500, 28_750, 43_750, 58_750]);

    h.setActive([running("a", 50)]);
    await vi.advanceTimersByTimeAsync(15_000); // 看到变化
    await vi.advanceTimersByTimeAsync(5_000); // 回到 5s
    expect(h.requests.slice(-2)).toEqual([73_750, 78_750]);
    expect(h.updates).toEqual(["a:10", "a:50"]);
  });

  it("盯着的任务从进行中列表消失 → onFinished 恰好一次，然后停止轮询", async () => {
    const h = harness([running("a")]);
    h.poller.watch("a");
    await vi.advanceTimersByTimeAsync(5_000);
    h.setActive([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.finished).toEqual(["a"]);
    expect(h.poller.watchedIds()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.requests).toHaveLength(2);
  });

  it("页面不可见时暂停；回到前台立刻补一轮", async () => {
    const h = harness([running("a")]);
    h.poller.watch("a");
    await vi.advanceTimersByTimeAsync(5_000);
    h.setHidden(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.requests).toHaveLength(2); // 隐藏前已排好的那一轮跑完后不再排下一轮
    h.setHidden(false);
    h.poller.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests).toHaveLength(3);
  });

  it("unwatch 最后一个任务就停止定时器", async () => {
    const h = harness([running("a")]);
    h.poller.watch("a");
    h.poller.unwatch("a");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.requests).toEqual([]);
  });
});
