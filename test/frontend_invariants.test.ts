import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

const ROOT = resolve(__dirname, "..");
const HTML = readFileSync(resolve(ROOT, "public/index.html"), "utf-8");
const CSS = readFileSync(resolve(ROOT, "public/app.css"), "utf-8");
const JS_I18N = readFileSync(resolve(ROOT, "public/js/08-i18n.js"), "utf-8");
const JS_EPISODES = readFileSync(resolve(ROOT, "public/js/30-episodes.js"), "utf-8");
const JS_SUBSCRIPTIONS = readFileSync(resolve(ROOT, "public/js/20-subscriptions.js"), "utf-8");
const JS_TASKS = readFileSync(resolve(ROOT, "public/js/40-tasks.js"), "utf-8");
const BUNDLE = readFileSync(resolve(ROOT, "public/app.js"), "utf-8");
const SETTINGS_TS = readFileSync(resolve(ROOT, "src/settings.ts"), "utf-8");
const JS_CORE = readFileSync(resolve(ROOT, "public/js/10-core.js"), "utf-8");
const JS_READER = readFileSync(resolve(ROOT, "public/js/60-reader.js"), "utf-8");
const JS_SETTINGS = readFileSync(resolve(ROOT, "public/js/95-settings.js"), "utf-8");
const FRAGMENTS = readdirSync(resolve(ROOT, "public/js"))
  .filter(name => name.endsWith(".js"))
  .map(name => ({ name, source: readFileSync(resolve(ROOT, "public/js", name), "utf-8") }));

describe("Frontend Invariants & Correctness Blockers", () => {
  describe("Blocker 1: 781–1180px episode details & inspector visibility", () => {
    it("uses hasPersistentInspector() rather than isMobileViewport() for drawer decision", () => {
      expect(JS_EPISODES).toContain("function hasPersistentInspector()");
      expect(JS_EPISODES).toContain("if (!hasPersistentInspector()) openEpisodeSummary();");
      expect(BUNDLE).toContain("hasPersistentInspector");
    });

    it("evaluates hasPersistentInspector logic correctly across viewport widths", () => {
      function simulateHasPersistentInspector(width: number, railDisplay: string) {
        if (railDisplay === "none") return false;
        return width > 1180;
      }

      // Large desktop: inspector persistent
      expect(simulateHasPersistentInspector(1440, "block")).toBe(true);
      expect(simulateHasPersistentInspector(1200, "block")).toBe(true);

      // Medium screen (781-1180px): rail hidden, drawer must open
      expect(simulateHasPersistentInspector(1180, "none")).toBe(false);
      expect(simulateHasPersistentInspector(1024, "none")).toBe(false);
      expect(simulateHasPersistentInspector(800, "none")).toBe(false);

      // Small screen (<=780px): rail hidden, drawer must open
      expect(simulateHasPersistentInspector(780, "none")).toBe(false);
      expect(simulateHasPersistentInspector(375, "none")).toBe(false);
    });

    it("ensures CSS responsive tiers hide right-rail and display drawer on <=1180px", () => {
      // 781-1180px tier
      expect(CSS).toMatch(/@media\s*\(min-width:\s*781px\)\s*and\s*\(max-width:\s*1180px\)/);
      expect(CSS).toContain(".episode-summary-drawer {");
      expect(CSS).toContain("transform: translateX(105%);");

      // <=780px tier
      expect(CSS).toMatch(/@media\s*\(max-width:\s*780px\)/);
      expect(CSS).toContain("transform: translateY(105%);");
    });
  });

  describe("Episode actions are explicit", () => {
    it("has direct download/rerun actions and no ellipsis menu", () => {
      expect(JS_EPISODES).toContain("createEpisodeDownloadAction");
      expect(JS_EPISODES).toContain("createEpisodeRerunAction");
      expect(JS_EPISODES).not.toContain("episode-more");
      expect(JS_EPISODES).not.toContain("•••");
      expect(HTML).not.toContain("•••");
    });
  });

  describe("Blocker 3: Task queue trigger reachability for failed/cancelled tasks", () => {
    function computeTriggerState(tasks: Array<{ status: string }>) {
      const runningCount = tasks.filter(t => t.status === "running" || t.status === "pending" || t.status === "processing").length;
      const attentionCount = tasks.filter(t => t.status === "failed" || t.status === "cancelled").length;
      const isVisible = runningCount > 0 || attentionCount > 0;
      let label = "";
      if (runningCount > 0) {
        label = `处理中 ${runningCount}`;
      } else if (attentionCount > 0) {
        label = `${attentionCount} 个任务需要处理`;
      }
      return { isVisible, label };
    }

    it("displays '处理中 N' when running tasks exist", () => {
      const state = computeTriggerState([{ status: "running" }, { status: "failed" }]);
      expect(state.isVisible).toBe(true);
      expect(state.label).toBe("处理中 1");
    });

    it("displays 'N 个任务需要处理' when only failed/cancelled tasks exist", () => {
      const state = computeTriggerState([{ status: "failed" }, { status: "cancelled" }]);
      expect(state.isVisible).toBe(true);
      expect(state.label).toBe("2 个任务需要处理");
    });

    it("hides trigger only when queue is completely empty or all tasks succeeded", () => {
      const emptyState = computeTriggerState([]);
      expect(emptyState.isVisible).toBe(false);

      const successState = computeTriggerState([{ status: "success" }]);
      expect(successState.isVisible).toBe(false);
    });

    it("implements attention count and label in 40-tasks.js", () => {
      expect(JS_TASKS).toContain("attentionCount");
      expect(JS_TASKS).toContain("t('tasks.attention_count', attentionCount)");
      expect(JS_TASKS).toContain("t('tasks.processing_count', runningCount)");
      expect(BUNDLE).toContain("个任务需要处理");
      expect(BUNDLE).toContain("处理中 {0}");
    });
  });

  describe("Blocker 4: 任务、已读、已完成都按稳定 id 关联，不再用「节目名::标题」", () => {
    it("任务卡按 episode_id 匹配单集；导入音频的任务不参与单集匹配", () => {
      expect(JS_EPISODES).toContain("task.isCustomUpload");
      expect(JS_EPISODES).toContain("task.episodeId === key");
      expect(JS_TASKS).toContain("if (task.episode_id) card.episodeId = String(task.episode_id);");
    });

    it("已读按 episode_id / task_id 记；已完成直接用分页项的 article_task_id；前端不再拼接「节目名::标题」", () => {
      expect(JS_CORE).toContain("if (ref.episode_id) return 'episode:' + ref.episode_id;");
      expect(JS_CORE).toContain("if (ref.task_id) return 'task:' + ref.task_id;");
      expect(JS_EPISODES).toContain("if (!episode || !episode.article_task_id) return null;");
      for (const { name, source } of FRAGMENTS) {
        expect(source, name).not.toContain("completed-keys");
        expect(source, name).not.toMatch(/['"]::['"]/);
      }
    });
  });

  describe("Blocker 5: Accurate failure stage messages", () => {
    function resolveTaskFailureMessage(task: { message?: string; stage?: string }) {
      if (!task) return "这次没有生成成功，请稍后再试。";
      const msg = String(task.message || "").trim();
      if (msg && !/^([a-z0-9_]+|error|\[object.*\])$/i.test(msg) && msg !== "AI 整理暂时没有完成。") {
        return msg;
      }
      const stage = String(task.stage || "");
      if (stage === "downloading" || stage === "queued" || stage === "resolving") {
        return "无法获取音频，请稍后重试。";
      }
      if (stage === "transcribing") {
        return "这次没有完成转写，请重试。";
      }
      if (stage === "refining") {
        return "文字整理暂时没有完成，请重试。";
      }
      if (stage === "finalizing") {
        return "稿件保存失败，请重试。";
      }
      return "这次没有生成成功，请稍后再试。";
    }

    it("preserves specific backend public error messages", () => {
      expect(resolveTaskFailureMessage({ message: "音频文件不存在 (404)" })).toBe("音频文件不存在 (404)");
      expect(resolveTaskFailureMessage({ message: "转写服务配额不足" })).toBe("转写服务配额不足");
    });

    it("does not blanket overwrite with 'AI 整理暂时没有完成。'", () => {
      expect(resolveTaskFailureMessage({ stage: "downloading", message: "AI 整理暂时没有完成。" })).toBe("无法获取音频，请稍后重试。");
      expect(resolveTaskFailureMessage({ stage: "transcribing", message: "AI 整理暂时没有完成。" })).toBe("这次没有完成转写，请重试。");
      expect(resolveTaskFailureMessage({ stage: "finalizing", message: "AI 整理暂时没有完成。" })).toBe("稿件保存失败，请重试。");
    });

    it("maps stage-based fallbacks accurately", () => {
      expect(resolveTaskFailureMessage({ stage: "queued" })).toBe("无法获取音频，请稍后重试。");
      expect(resolveTaskFailureMessage({ stage: "transcribing" })).toBe("这次没有完成转写，请重试。");
      expect(resolveTaskFailureMessage({ stage: "refining" })).toBe("文字整理暂时没有完成，请重试。");
      expect(resolveTaskFailureMessage({ stage: "finalizing" })).toBe("稿件保存失败，请重试。");
    });
  });

  describe("Dead code & markup hygiene", () => {
    it("ensures public/index.html does not contain dead elements", () => {
      expect(HTML).not.toContain('id="history-section"');
      expect(HTML).not.toContain('id="clock"');
      expect(HTML).not.toContain('id="edition-date"');
      expect(HTML).not.toContain('class="server-state"');
      expect(HTML).not.toContain('class="drawer-modes"');
      expect(HTML).not.toContain('class="drawer-manual"');
      expect(HTML).not.toContain('class="drawer-confirm"');
    });

    it("sets initial mobile-nav active state and body data-mode to podcast", () => {
      expect(HTML).toContain('<body data-mode="podcast">');
      expect(HTML).toMatch(/<button[^>]*class="[^"]*active[^"]*"[^>]*data-mode="podcast"/);
    });

    it("ensures public/app.css does not contain dead selector rules", () => {
      expect(CSS).not.toContain(".history-section");
      expect(CSS).not.toContain(".history-head");
      expect(CSS).not.toContain(".server-state");
      expect(CSS).not.toContain(".drawer-manual");
      expect(CSS).not.toContain(".drawer-confirm");
    });

    it("uses neutral '任务' panel title instead of fixed '处理中'", () => {
      expect(HTML).toMatch(/id="task-panel-title"[^>]*>任务<\/h2>/);
      expect(HTML).toContain('aria-label="关闭任务面板"');
      expect(HTML).toMatch(/class="task-queue-head"><strong[^>]*>任务<\/strong>/);
    });

    it("ensures src/settings.ts does not export dead helpers or retain drifted configured badge docstrings", () => {
      expect(SETTINGS_TS).not.toContain("serviceHost");
      expect(SETTINGS_TS).not.toContain("transcriptionServiceGroup");
      expect(SETTINGS_TS).not.toContain("UI 只显示 configured 徽标");
      expect(SETTINGS_TS).not.toContain("只读展示 + 连通性探针");
    });
  });

  describe("Startup & navigation regression guards", () => {
    it("never binds a static byId listener to an element missing from index.html", () => {
      const boundIds = [...BUNDLE.matchAll(/byId\(['"]([^'"]+)['"]\)\.addEventListener/g)].map(match => match[1]);
      const htmlIds = new Set([...HTML.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]));
      const missing = [...new Set(boundIds)].filter(id => !htmlIds.has(id));
      expect(missing).toEqual([]);
    });

    it("keeps the desktop left rail width stable across all three workspaces", () => {
      expect(CSS).toContain(
        'body[data-mode="custom"] .workspace,\n    body[data-mode="library"] .workspace { grid-template-columns: minmax(220px, 260px) minmax(0, 1fr); }'
      );
      expect(CSS).not.toContain('grid-template-columns: 190px minmax(0, 1fr)');
    });

    it("keeps manuscript download as a direct visible action", () => {
      expect(JS_TASKS).not.toContain("library-more");
      expect(JS_TASKS).toContain("actions.append(read, download)");
      expect(JS_TASKS).toContain("document.createTextNode(t('library.download'))");
    });
  });

  describe("Public Browse Mode / Authenticated Control Mode", () => {
    // 从 10-core.js 取出真实的路径识别函数执行，而不是复制一份逻辑。
    const detectSource = JS_CORE.slice(JS_CORE.indexOf("(function detectLocation()"), JS_CORE.indexOf("}());", JS_CORE.indexOf("(function detectLocation()")) + 5);
    const detect = (pathname: string) => new Function("window", `return ${detectSource};`)({ location: { pathname } });

    it.each([
      ["/", "", "public"],
      ["/podcast", "/podcast", "public"],
      ["/podcast/", "/podcast", "public"],
      ["/manage", "", "manage"],
      ["/manage/", "", "manage"],
      ["/manage/anything", "", "manage"],
      ["/podcast/manage", "/podcast", "manage"],
      ["/manager", "/manager", "public"],
    ])("%s → base %j, surface %s", (pathname, base, surface) => {
      expect(detect(pathname)).toEqual({ base, surface });
    });

    it("index.html 与 10-core.js 使用同一条 /manage 识别规则，并在首屏前标记 surface", () => {
      expect(HTML).toContain("currentPath.match(/^(.*?)\\/manage(?:\\/.*)?$/)");
      expect(JS_CORE).toContain("path.match(/^(.*?)\\/manage(?:\\/.*)?$/)");
      expect(HTML).toContain("document.documentElement.dataset.surface = manage ? 'manage' : 'public';");
    });

    it("公开浏览渲染同一套工作区：只有主人状态（任务 / 已读 / 阅读进度）不渲染", () => {
      expect(CSS).toContain('html[data-surface="public"] .owner-state-only { display: none !important; }');
      // 旧的整块隐藏（左栏、订阅面板、检视栏、移动导航）与公开专用布局都已移除。
      expect(HTML).not.toContain("manage-only");
      expect(CSS).not.toContain("manage-only");
      expect(CSS).not.toMatch(/html\[data-surface="public"\] \.(workspace|content|app-shell)\b/);
      for (const id of ["settings-btn", "podcast-panel", "custom-panel", "library-panel", "add-podcast-btn", "refresh-btn", "episode-search", "reader-download"]) {
        expect(HTML, id).toMatch(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`));
        expect(HTML.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`))![0], id).not.toContain("owner-state-only");
      }
      for (const cls of ["left-rail", "right-rail", "mobile-nav", "nav-tabs"]) {
        expect(HTML.match(new RegExp(`<[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`))![0], cls).not.toContain("owner-state-only");
      }
      for (const id of ["task-panel-btn", "reader-read-toggle"]) {
        expect(HTML, id).toMatch(new RegExp(`class="[^"]*\\bowner-state-only\\b[^"]*" id="${id}"`));
      }
      for (const cls of ["library-filter", "reader-progress-line"]) {
        expect(HTML, cls).toMatch(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*\\bowner-state-only\\b`));
      }
      expect(HTML).toMatch(/class="story-filter owner-state-only" role="tablist" aria-label="阅读状态过滤"/);
      expect(HTML).toMatch(/class="[^"]*public-only[^"]*" id="manage-link" href="\/manage">登录管理<\/a>/);
    });

    it("两种模式进入同一个工作区；任务与已读只在控制模式加载", () => {
      const boot = JS_SETTINGS.slice(JS_SETTINGS.indexOf("watchSystemTheme();\n    initSettings();"));
      const shared = boot.slice(0, boot.indexOf("if (IS_MANAGE) {"));
      const manageBranch = boot.slice(boot.indexOf("if (IS_MANAGE) {"), boot.indexOf("} else {"));
      expect(shared).toContain("loadSubscriptions();");
      for (const call of ["loadHistory();", "loadReadEpisodes();", "applyControlIntent(subscriptionsReady);"]) {
        expect(manageBranch, call).toContain(call);
        expect(JS_SETTINGS.split(call).length - 1, call).toBe(1);
      }
      expect(BUNDLE).toContain("switchMode('podcast');");
      expect(BUNDLE).not.toContain("switchMode(IS_MANAGE ? 'podcast' : 'library');");
    });

    it("公开浏览不写读者状态：已读与阅读位置都只在控制模式", () => {
      expect(JS_CORE).toMatch(/function setRead\(ref, read\) \{[\s\S]{0,120}if \(!IS_MANAGE\) return;/);
      expect(BUNDLE).toContain("var saved = IS_MANAGE ? localStorage.getItem('scroll_pos_' + cleanId) : null;");
      expect(BUNDLE).toContain("if (!_currentReadingTaskId || !IS_MANAGE) return;");
    });

    it("浏览读取经 browseApi 分流；旧的 /api/read-podcast/* 前缀已不存在", () => {
      expect(JS_CORE).toContain("return appUrl((IS_MANAGE ? '/api/control' : '/api/public') + path);");
      expect(JS_CORE).toContain("IS_MANAGE ? appUrl('/api/control/tasks/' + id + suffix) : appUrl('/api/public/articles/' + id + suffix)");
      expect(BUNDLE).not.toContain("/api/read-podcast/");
    });
  });

  describe("阅读器工具栏动作必须直接可见", () => {
    const readerActions = HTML.slice(HTML.indexOf('<div class="reader-actions">'), HTML.indexOf("</header>", HTML.indexOf('<div class="reader-actions">')));

    it("下载与主人态已读切换都不是菜单项", () => {
      const download = readerActions.match(/<a class="reader-download" id="reader-download"[^>]*>[\s\S]*?<\/a>/);
      expect(download, "reader toolbar download").not.toBeNull();
      expect(download![0]).toContain("下载 Markdown");
      expect(download![0]).not.toContain("owner-state-only");
      expect(readerActions).toContain('id="reader-read-toggle"');
      expect(readerActions).toContain("owner-state-only");
      expect(readerActions).not.toContain("reader-more-menu");
      expect(readerActions).not.toContain("•••");
    });

    it("窄屏只把下载文字收成图标，入口仍留在工具栏", () => {
      expect(CSS).toContain(".reader-download-label { position: absolute;");
    });
  });

  describe("Reader Redesign: UX, themes and typography (Issue #28)", () => {
    it("supports 5 reader themes (follow, paper, warm, green, dark) and defaults to follow app", () => {
      // index.html initializes with follow app default
      expect(HTML).toContain('data-reader-theme="follow"');
      for (const theme of ["follow", "paper", "warm", "green", "dark"]) {
        expect(HTML).toContain(`data-theme="${theme}"`);
      }
      // CSS defines scoped tokens for all themes
      expect(CSS).toContain('.reader[data-reader-theme="paper"]');
      expect(CSS).toContain('.reader[data-reader-theme="warm"]');
      expect(CSS).toContain('.reader[data-reader-theme="green"]');
      expect(CSS).toContain('.reader[data-reader-theme="dark"]');
      expect(CSS).toContain('html[data-app-theme="dark"] .reader[data-reader-theme="follow"]');
      expect(CSS).toContain('html[data-app-theme="light"] .reader[data-reader-theme="follow"]');
    });

    it("isolates reader chrome tokens to eliminate dark-mode contrast bugs", () => {
      // Popovers and sheets must use --reader-surface and --reader-line rather than leaking app tokens
      expect(CSS).toContain(".reader-menu-popover { position: absolute; z-index: 10; top: calc(100% + 8px); right: 0; min-width: 260px; padding: 14px; border: 1px solid var(--reader-line); border-radius: var(--radius-md); background: var(--reader-surface);");
      expect(CSS).not.toMatch(/\.reader-menu-popover\s*\{[^}]*background:\s*var\(--surface-strong\)/);
      expect(CSS).not.toMatch(/\.reader-menu-popover\s*\{[^}]*border:[^;]*var\(--border\)/);
    });

    it("provides classical and modern typography presets with font size and line spacing", () => {
      // Presets
      expect(HTML).toContain('data-preset="classical"');
      expect(HTML).toContain('data-preset="modern"');
      expect(CSS).toContain('--reader-font-classical');
      expect(CSS).toContain('--reader-font-modern');
      expect(CSS).toMatch(/--reader-font-classical:\s*Georgia,\s*"Nimbus Roman No9 L",\s*"Times New Roman",\s*"STFangsong",\s*"FangSong"/);
      expect(CSS).toContain('.reader[data-reader-font="classical"] .manuscript-body');
      expect(CSS).toContain('.reader[data-reader-font="modern"] .manuscript-body');

      // Font size
      expect(HTML).toContain('id="font-dec-btn"');
      expect(HTML).toContain('id="font-inc-btn"');
      expect(HTML).toContain('id="font-size-val"');

      // Leading; reader width is intentionally fixed to one wide content measure.
      expect(HTML).toContain('data-leading="compact"');
      expect(HTML).toContain('data-leading="normal"');
      expect(HTML).toContain('data-leading="relaxed"');
      expect(HTML).not.toContain('data-width=');
      expect(CSS).toContain('--reader-content-width: 1040px');
    });

    it("implements dual-track preferences: D1 cloud sync in manage mode and localStorage in unauthenticated mode", () => {
      // Unauthenticated mode uses localStorage via savePreference/loadLocalPreferences in 10-core
      expect(JS_CORE).toContain("function savePreference(key, value)");
      expect(JS_CORE).toContain("function loadLocalPreferences()");
      expect(JS_CORE).toContain("localStorage.setItem(localKey, String(value))");
      expect(JS_CORE).toContain("syncCloudPreferences(patch)");
      expect(JS_CORE).toContain("if (!IS_MANAGE || !patch) return;");

      // Setters route through savePreference
      expect(JS_READER).toContain("savePreference('font_size', _currentFontSize)");
      expect(JS_READER).toContain("savePreference('reader_theme', theme)");
      expect(JS_READER).toContain("savePreference('font_preset', _currentFontPreset)");
      expect(JS_READER).toContain("savePreference('line_height', _currentLineHeight)");
      expect(JS_READER).not.toContain("margin_width");
      expect(JS_CORE).not.toContain("reader_margin");
      expect(JS_SETTINGS).toContain("savePreference('app_theme', value)");

      // HTML anti-FOUC guards only read localStorage for unauthenticated visitors (!isManage)
      expect(HTML).toContain("theme = localStorage.getItem('app_theme') || 'auto'");
      expect(HTML).toContain("if (!isManage)");

      // Bundle export checks
      expect(BUNDLE).toContain("syncCloudPreferences");
      expect(BUNDLE).toContain("loadCloudPreferences");
      expect(BUNDLE).toContain("savePreference");
    });

    it("implements responsive mobile bottom reading toolbar and bottom sheets", () => {
      // Mobile bottom bar buttons
      expect(HTML).toContain('id="reader-bar-toc-btn"');
      expect(HTML).toContain('id="reader-bar-progress-btn"');
      expect(HTML).toContain('id="reader-bar-appearance-btn"');

      // Sheets & backdrop
      expect(HTML).toContain('id="reader-sheet-backdrop"');
      expect(HTML).toContain('id="reader-progress-sheet"');

      // Responsive CSS
      expect(CSS).toContain(".reader-bottom-bar {");
      expect(CSS).toContain(".reader-sheet-backdrop {");
      expect(CSS).toContain(".reader-bottom-sheet {");
      expect(CSS).toMatch(/@media\s*\(max-width:\s*780px\)\s*\{[\s\S]*?\.reader-bottom-bar\s*\{/);
      expect(CSS).toMatch(/@media\s*\(max-width:\s*780px\)[\s\S]*?\.reader-appearance\s*\{\s*display:\s*none;?\s*\}/);
      expect(CSS).not.toContain("@media (max-width: 860px)");
    });

    it("keeps download and mark read/unread in secondary actions rather than typography controls", () => {
      const appearanceMenu = HTML.slice(HTML.indexOf('id="reader-appearance-menu"'), HTML.indexOf("</details>", HTML.indexOf('id="reader-appearance-menu"')));
      expect(appearanceMenu).not.toContain("reader-download");
      expect(appearanceMenu).not.toContain("reader-read-toggle");
    });
  });

  describe("Issue #30: Reader Duplicate Outline and Desktop/Public Toolbar Regressions", () => {
    it("reader presentation removes generated outline/timeline section while preserving real chapters", () => {
      expect(JS_READER).toContain("function stripOpeningOutline(markdown)");
      expect(BUNDLE).toContain("stripOpeningOutline");

      const fnSource = JS_READER.slice(
        JS_READER.indexOf("function stripOpeningOutline(markdown) {"),
        JS_READER.indexOf("function renderBasicMarkdown(markdown) {")
      );
      const stripOpeningOutline = new Function(`return (${fnSource.trim()});`)();

      const refinedMarkdown = `---
title: 袁长庚×胡安焉
---

### 📌 节目大纲与时间线
- **00:05:50** 话题一
- **00:07:38** 话题二

---

## 01 | 工作与人生意义

正文段落。`;

      const stripped = stripOpeningOutline(refinedMarkdown);
      expect(stripped).toContain("## 01 | 工作与人生意义");
      expect(stripped).toContain("正文段落。");
      expect(stripped).not.toContain("节目大纲与时间线");
      expect(stripped).not.toContain("话题一");

      // 只识别系统真实生成的 canonical 标题；无分隔线时也应正常剔除
      const noHrMarkdown = `### 节目大纲与时间线\n- 01:00 开头\n\n## 01 | 标题\n\n正文`;
      expect(stripOpeningOutline(noHrMarkdown)).toBe("## 01 | 标题\n\n正文");

      // 关键防回归：合法正文以 ## 时间线 / ## 大纲 开头时保持不变，绝不误删
      const legitimateTimelineMarkdown = `## 时间线\n\n2020 年……\n2021 年……\n\n## 第一章\n\n章节内容。`;
      expect(stripOpeningOutline(legitimateTimelineMarkdown)).toBe(legitimateTimelineMarkdown);

      const legitimateOutlineMarkdown = `## 大纲\n\n本文主要探讨三个问题……\n\n## 01 | 深入探讨\n\n详细展开。`;
      expect(stripOpeningOutline(legitimateOutlineMarkdown)).toBe(legitimateOutlineMarkdown);

      const level3LegitMarkdown = `### 时间线\n事件按年份记录。\n\n### 正文\n具体内容。`;
      expect(stripOpeningOutline(level3LegitMarkdown)).toBe(level3LegitMarkdown);
    });

    it("desktop appearance menu is not constrained by header overflow and stacks above reader-layout", () => {
      // .reader-head 必须允许 popover 向下延伸 (overflow: visible) 且显式高于 reader-layout (z-index: 20 vs 1)
      expect(CSS).toMatch(/\.reader-head\s*\{[^}]*position:\s*relative;/);
      expect(CSS).toMatch(/\.reader-head\s*\{[^}]*z-index:\s*20;/);
      expect(CSS).toMatch(/\.reader-head\s*\{[^}]*overflow:\s*visible;/);
      expect(CSS).not.toMatch(/\.reader-head\s*\{[^}]*overflow:\s*hidden;/);

      // .reader-layout 建立独立的较低层叠上下文
      expect(CSS).toMatch(/\.reader-layout\s*\{[^}]*position:\s*relative;/);
      expect(CSS).toMatch(/\.reader-layout\s*\{[^}]*z-index:\s*1;/);

      // 外层 .reader-sheet 保持 overflow: hidden 保证圆角与收起动画不受破坏
      expect(CSS).toMatch(/\.reader-sheet\s*\{[^}]*overflow:\s*hidden;/);
      expect(CSS).toMatch(/\.reader-sheet\s*\{[^}]*border-radius:\s*var\(--radius-lg\);/);
    });

    it("public owner-only controls are not rendered and theme selection is explicit", () => {
      expect(JS_SUBSCRIPTIONS).toContain("if (!IS_MANAGE)");
      expect(JS_SETTINGS).toContain("function selectPublicTheme(value)");
      expect(JS_SETTINGS).not.toContain("cyclePublicTheme");
      expect(HTML).toContain('data-public-theme="auto"');
      expect(HTML).toContain('data-public-theme="light"');
      expect(HTML).toContain('data-public-theme="dark"');
    });
  });

  describe("Bundle 与 API 错误协议", () => {
    it("strict mode 真正生效：'use strict' 是 bundle 的第一条语句，任何分片里都不再出现", () => {
      expect(BUNDLE.startsWith("'use strict';\n")).toBe(true);
      for (const { name, source } of FRAGMENTS) {
        expect(source, name).not.toMatch(/^\s*['"]use strict['"];?\s*$/m);
      }
    });

    it("任务进度只有一个轮询器（GET /tasks?active=true），不再给每个任务开定时器", () => {
      expect(JS_TASKS).not.toContain("setInterval");
      expect(JS_TASKS).toContain("function createTaskPoller(options)");
      expect(JS_TASKS).toContain("/api/control/tasks?active=true");
      expect(JS_TASKS).toContain("visibilitychange");
    });

    it("写操作统一经 readApiResponse 解析错误，不再读取服务端从未返回过的 data.detail", () => {
      for (const { name, source } of FRAGMENTS) {
        expect(source, name).not.toMatch(/new Error\([^)]*data\.detail/);
        expect(source, name).not.toContain("readJsonResponse");
      }
      expect(JS_CORE).toContain("function readApiResponse(response)");
    });

    function loadReadApiResponse(): (response: Response) => Promise<unknown> {
      const start = JS_CORE.indexOf("function readApiResponse(response) {");
      let depth = 0;
      let end = start;
      for (let i = JS_CORE.indexOf("{", start); i < JS_CORE.length; i += 1) {
        if (JS_CORE[i] === "{") depth += 1;
        if (JS_CORE[i] === "}" && --depth === 0) {
          end = i + 1;
          break;
        }
      }
      return new Function(`${JS_CORE.slice(start, end)}; return readApiResponse;`)();
    }

    it("readApiResponse：失败时抛出服务端 error.message 并带 status；204 空 body 视为成功", async () => {
      const readApiResponse = loadReadApiResponse();
      const conflict = new Response(JSON.stringify({ error: { code: "already_processed", message: "该节目已转录完成" } }), { status: 409 });
      await expect(readApiResponse(conflict)).rejects.toMatchObject({ message: "该节目已转录完成", status: 409 });
      await expect(readApiResponse(new Response("upstream down", { status: 502 }))).rejects.toMatchObject({ message: "HTTP 502", status: 502 });
      await expect(readApiResponse(new Response(null, { status: 204 }))).resolves.toBeNull();
      await expect(readApiResponse(Response.json({ task_id: "t" }))).resolves.toEqual({ task_id: "t" });
    });
  });

  describe("Bilingual UI & i18n Invariants", () => {
    it("guarantees identical key sets between TRANSLATIONS.zh and TRANSLATIONS.en", () => {
      const zhMatch = JS_I18N.match(/zh:\s*\{([\s\S]*?)\n\s*\},/);
      const enMatch = JS_I18N.match(/en:\s*\{([\s\S]*?)\n\s*\}\n\s*\};/);
      expect(zhMatch).not.toBeNull();
      expect(enMatch).not.toBeNull();

      const zhKeys = new Set([...zhMatch![1].matchAll(/'([a-zA-Z0-9_.]+)':/g)].map(m => m[1]));
      const enKeys = new Set([...enMatch![1].matchAll(/'([a-zA-Z0-9_.]+)':/g)].map(m => m[1]));

      expect(zhKeys.size).toBeGreaterThan(250);
      expect(enKeys.size).toBe(zhKeys.size);

      const missingInEn = [...zhKeys].filter(k => !enKeys.has(k));
      const missingInZh = [...enKeys].filter(k => !zhKeys.has(k));
      expect(missingInEn).toEqual([]);
      expect(missingInZh).toEqual([]);
    });

    it("verifies all data-i18n* attributes in public/index.html exist in TRANSLATIONS", () => {
      const zhMatch = JS_I18N.match(/zh:\s*\{([\s\S]*?)\n\s*\},/);
      const zhKeys = new Set([...zhMatch![1].matchAll(/'([a-zA-Z0-9_.]+)':/g)].map(m => m[1]));

      const htmlI18nKeys = [...HTML.matchAll(/data-i18n(?:-[a-z\-]+)?="([^"]+)"/g)].map(m => m[1]);
      expect(htmlI18nKeys.length).toBeGreaterThan(50);

      const unmappedKeys = htmlI18nKeys.filter(k => !zhKeys.has(k));
      expect(unmappedKeys).toEqual([]);
    });

    it("verifies index.html has no static Chinese text or attributes without data-i18n mapping", () => {
      const lines = HTML.split("\n");
      const unmapped: string[] = [];

      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        const stripped = line.replace(/<!--.*?-->/g, "");
        if (stripped.includes("中 / EN") || stripped.includes("// <base>/ 是公开浏览")) continue;
        if (/[\u4e00-\u9fa5]/.test(stripped) && !stripped.includes("data-i18n")) {
          unmapped.push(`Line ${idx + 1}: ${line.trim()}`);
        }
      }
      expect(unmapped).toEqual([]);
    });

    it("evaluates English mode invariant: applyLocale('en') leaves no Chinese characters in static DOM", () => {
      const virtualConsole = new VirtualConsole();
      const dom = new JSDOM(HTML, {
        url: "https://example.com/manage",
        runScripts: "dangerously",
        pretendToBeVisual: true,
        virtualConsole,
        beforeParse(window) {
          Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
          (window as unknown as { fetch: typeof fetch }).fetch = (() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })) as unknown as typeof fetch;
        }
      });

      const script = dom.window.document.createElement("script");
      script.textContent = BUNDLE;
      dom.window.document.body.appendChild(script);

      const win = dom.window as unknown as { applyLocale: (locale: string) => void };
      win.applyLocale("en");

      expect(dom.window.document.documentElement.lang).toBe("en");
      expect(dom.window.document.documentElement.dataset.locale).toBe("en");

      const issues: Array<{ type: string; value: string; context?: string }> = [];
      function scanNode(node: Node) {
        if (node.nodeType === 3) {
          const text = (node.textContent || "").trim();
          if (text === "中 / EN") return;
          if (/[\u4e00-\u9fa5]/.test(text)) {
            issues.push({ type: "text", value: text, context: (node.parentElement as HTMLElement)?.outerHTML?.slice(0, 100) });
          }
        } else if (node.nodeType === 1) {
          const el = node as HTMLElement;
          if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
          for (const attr of ["aria-label", "title", "placeholder"]) {
            const val = el.getAttribute(attr);
            if (val && /[\u4e00-\u9fa5]/.test(val)) {
              issues.push({ type: "attr", value: `${attr}="${val}"`, context: el.outerHTML.slice(0, 100) });
            }
          }
          for (const child of Array.from(node.childNodes)) {
            scanNode(child);
          }
        }
      }

      scanNode(dom.window.document.body);
      expect(issues).toEqual([]);
    });

    it("verifies dynamic task queue localization and Chinese error suppression in English mode", () => {
      const virtualConsole = new VirtualConsole();
      const dom = new JSDOM(HTML, {
        url: "https://example.com/manage",
        runScripts: "dangerously",
        pretendToBeVisual: true,
        virtualConsole,
        beforeParse(window) {
          Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
          (window as unknown as { fetch: typeof fetch }).fetch = (() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })) as unknown as typeof fetch;
        }
      });

      const script = dom.window.document.createElement("script");
      script.textContent = BUNDLE;
      dom.window.document.body.appendChild(script);

      const win = dom.window as unknown as {
        applyLocale: (loc: string) => void;
        getLocale: () => string;
        setTaskStatus: (stage: string, progress: number, taskId?: string, title?: string, message?: string) => void;
        t: (key: string, ...args: unknown[]) => string;
      };

      win.applyLocale("en");
      expect(win.getLocale()).toBe("en");

      // Verify translation helper returns English strings
      expect(win.t("stage.queued")).toBe("Queued");
      expect(win.t("stage.downloading")).toBe("Downloading audio");
      expect(win.t("stage.transcribing")).toBe("Transcribing");
      expect(win.t("stage.refining")).toBe("Refining");
      expect(win.t("stage.finalizing")).toBe("Saving");
      expect(win.t("tasks.title")).toBe("Tasks");
      expect(win.t("tasks.processing_count", 2)).toBe("Processing 2");
      expect(win.t("tasks.attention_count", 3)).toBe("3 task(s) require attention");

      // Simulate a running task
      win.setTaskStatus("downloading", 20, "task-1", "Test Episode");
      const triggerLabel = dom.window.document.getElementById("task-trigger-label");
      expect(triggerLabel?.textContent).toBe("Processing 1");

      const taskItem = dom.window.document.querySelector("#task-list .task-queue-item");
      expect(taskItem).not.toBeNull();
      // Ensure no Chinese leaked into the running task item
      expect(/[\u4e00-\u9fa5]/.test(taskItem?.textContent || "")).toBe(false);

      // Simulate a failed task with a backend Chinese message in English mode
      win.setTaskStatus("downloading", 0, "task-2", "Another Episode", "音频下载失败 (404)");
      const failedCard = (dom.window as unknown as { _taskCards: Record<string, { status: string; message: string; stage: string }> })._taskCards["task-2"];
      if (failedCard) failedCard.status = "failed";
      (dom.window as unknown as { renderTaskQueue: () => void }).renderTaskQueue();

      const items = dom.window.document.querySelectorAll("#task-list .task-queue-item");
      expect(items.length).toBe(2);
      // Verify Chinese error message did not leak into English UI
      expect(/[\u4e00-\u9fa5]/.test(items[0]?.textContent || "")).toBe(false);
      expect(/[\u4e00-\u9fa5]/.test(items[1]?.textContent || "")).toBe(false);
    });

    it("renders Settings in English mode with real backend payload without leaking Chinese", () => {
      const settingsPayload = {
        writable: true,
        groups: [
          {
            key: "refiner",
            title: "文字整理",
            fields: [
              {
                key: "refiner.model",
                label: "模型",
                type: "text",
                placeholder: "服务商提供的模型 ID",
                value: "gpt-4o",
              },
              {
                key: "refiner.api_base",
                label: "服务地址",
                type: "text",
                placeholder: "https://api.example.com/v1",
                value: "https://api.openai.com/v1",
              },
              {
                key: "refiner.temperature",
                label: "创作温度",
                type: "text",
                placeholder: "0.3",
                value: "0.3",
              },
              {
                key: "refiner.max_tokens",
                label: "最大输出",
                type: "text",
                placeholder: "65536",
                value: "65536",
              },
            ],
          },
          {
            key: "quality",
            title: "完整度保护",
            description: "成稿明显过短时不会发布。",
            fields: [
              {
                key: "refiner.min_output_ratio",
                label: "完整度保护",
                type: "text",
                placeholder: "0.7",
                value: "0.7",
                hint: "这是发布硬下限；默认 Prompt 的编辑目标约为原始转录的 80%。",
              },
            ],
          },
        ],
      };

      const dom = new JSDOM(HTML, {
        runScripts: "dangerously",
        url: "http://localhost:8787/manage",
      });
      const script = dom.window.document.createElement("script");
      script.textContent = BUNDLE;
      dom.window.document.body.appendChild(script);

      const win = dom.window as unknown as {
        applyLocale: (loc: string) => void;
        renderSettings: (data: unknown) => void;
      };

      win.applyLocale("en");
      win.renderSettings(settingsPayload);

      const settingsBody = dom.window.document.getElementById("settings-body");
      expect(settingsBody).not.toBeNull();

      // Check all field labels, placeholders, hints and group headings in refiner & quality sections
      const labels = Array.from(settingsBody!.querySelectorAll(".settings-field .form-label")).map(el => el.textContent);
      const placeholders = Array.from(settingsBody!.querySelectorAll<HTMLInputElement>(".settings-field input")).map(el => el.placeholder);
      const hints = Array.from(settingsBody!.querySelectorAll(".settings-field-hint, .settings-group-desc")).map(el => el.textContent);

      // Verify no Chinese characters leak in refiner & quality settings
      for (const text of [...labels, ...placeholders, ...hints]) {
        expect(/[\u4e00-\u9fa5]/.test(text || "")).toBe(false);
      }

      // Check specific English labels
      expect(labels).toContain("Model");
      expect(labels).toContain("Endpoint URL");
      expect(labels).toContain("Temperature");
      expect(labels).toContain("Max Tokens");
      expect(labels).toContain("Length Quality Gate");
    });

    it("renders prompt templates with localized names and does not force Chinese prompt by default", () => {
      const templatesPayload = [
        { id: "magazine", name: "默认杂志精修", description: "杂志级访谈文稿...", content: "杂志级模板内容..." },
        { id: "clean_verbatim", name: "清洁逐字稿", description: "高保真逐字稿...", content: "清洁逐字稿内容..." },
        { id: "structured_interview", name: "结构化访谈", description: "重点突出问答结构...", content: "结构化访谈内容..." },
      ];

      const dom = new JSDOM(HTML, {
        runScripts: "dangerously",
        url: "http://localhost:8787/manage",
      });
      const script = dom.window.document.createElement("script");
      script.textContent = BUNDLE;
      dom.window.document.body.appendChild(script);

      const win = dom.window as unknown as {
        applyLocale: (loc: string) => void;
        _promptTemplates: unknown[];
        renderPromptTemplateOptions: () => void;
      };

      win.applyLocale("en");
      win._promptTemplates = templatesPayload;
      win.renderPromptTemplateOptions();

      const select = dom.window.document.getElementById("prompt-template-select") as unknown as HTMLSelectElement;
      expect(select).not.toBeNull();
      expect(select.options.length).toBe(4); // 1 default standard + 3 templates
      expect(select.options[0].textContent).toBe("Standard Refinement");
      expect(select.options[0].value).toBe("");
      expect(select.options[1].textContent).toBe("Magazine Refinement");
      expect(select.options[2].textContent).toBe("Clean Verbatim");
      expect(select.options[3].textContent).toBe("Structured Interview");

      // Verify no Chinese in template option names in English mode
      for (let i = 0; i < select.options.length; i++) {
        expect(/[\u4e00-\u9fa5]/.test(select.options[i].textContent || "")).toBe(false);
      }

      // Default selection must stay standard edit (index 0, empty value), not template 1
      expect(select.selectedIndex).toBe(0);
      const customPromptArea = dom.window.document.getElementById("custom-prompt") as unknown as HTMLTextAreaElement;
      expect(customPromptArea.value).toBe("");
    });

    it("calculates reader stats based on manuscript content language rather than UI locale", () => {
      const dom = new JSDOM(HTML, {
        runScripts: "dangerously",
        url: "http://localhost:8787/manage",
      });
      const script = dom.window.document.createElement("script");
      script.textContent = BUNDLE;
      dom.window.document.body.appendChild(script);

      const win = dom.window as unknown as {
        applyLocale: (loc: string) => void;
        updateReaderStats: (text: string) => void;
      };

      const chineseManuscript = `---
title: 测试中文单集
---
这是一篇中文播客的长篇精修访谈文稿。今天我们探讨分布式计算、边缘架构以及大规模语言模型在语音处理领域的最新进展。`.repeat(50); // ~4000 CJK chars

      const englishManuscript = `---
title: Test English Episode
---
This is an English podcast transcript discussing distributed systems, edge computing, and large language models for audio processing and refinement.`.repeat(50); // ~1000 English words

      const statsEl = dom.window.document.getElementById("reader-meta-stats");

      // Case A: English UI + Chinese manuscript
      win.applyLocale("en");
      win.updateReaderStats(chineseManuscript);
      expect(statsEl?.textContent).toBeTruthy();
      // Should calculate character count (~3600), not ~15 words!
      expect(statsEl?.textContent).toContain("characters");
      expect(statsEl?.textContent).not.toContain("words");

      // Case B: English UI + English manuscript
      win.updateReaderStats(englishManuscript);
      expect(statsEl?.textContent).toContain("words");
      expect(statsEl?.textContent).not.toContain("characters");

      // Case C: Chinese UI + Chinese manuscript
      win.applyLocale("zh");
      win.updateReaderStats(chineseManuscript);
      expect(statsEl?.textContent).toContain("字 · 约");
      expect(statsEl?.textContent).toContain("分钟");
    });
  });
});
