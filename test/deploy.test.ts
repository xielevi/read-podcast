/**
 * 部署可移植性：仓库本身不带任何部署者自己的值，部署值只经 scripts/deploy.mjs 注入。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error 无类型声明
import { buildCommunityDeploySteps, communityConfigFrom } from "../scripts/deploy_community.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf-8");
const SCRIPT = fileURLToPath(new URL("scripts/deploy.mjs", ROOT));

const VALID = {
  READ_PODCAST_DOMAIN: "podcast.mydomain.net",
  READ_PODCAST_TRANSCRIPTION_URL: "https://transcribe.mydomain.net",
  READ_PODCAST_GITHUB_OWNER: "someone",
  READ_PODCAST_GITHUB_REPO: "notes",
};

/** 运行部署脚本的 --print-args 模式；不读取开发者本地的 .deploy.env。 */
function run(env: Record<string, string>, args: string[] = []) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("READ_PODCAST_")));
  return spawnSync(process.execPath, [SCRIPT, "--print-args", ...args], {
    env: { ...clean, READ_PODCAST_DEPLOY_ENV: "/nonexistent/.deploy.env", ...env },
    encoding: "utf-8",
  });
}

describe("scripts/deploy.mjs", () => {
  it("把部署值映射为 --domain 与 Worker vars，并原样透传其余参数", () => {
    const result = run({ ...VALID, READ_PODCAST_GITHUB_PATH: "测试/转录", READ_PODCAST_TIME_ZONE: "Europe/Berlin" }, ["--dry-run"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      "deploy",
      "--domain", "podcast.mydomain.net",
      "--var", "CONTROL_AUTH_MODE:access",
      "--var", "TRANSCRIPTION_SERVICE_URL:https://transcribe.mydomain.net",
      "--var", "GITHUB_OWNER:someone",
      "--var", "GITHUB_REPO:notes",
      "--var", "GITHUB_PODCAST_PATH:测试/转录",
      "--var", "MANUSCRIPT_TIME_ZONE:Europe/Berlin",
      "--dry-run",
    ]);
  });

  it("缺少必填值时拒绝部署", () => {
    const result = run({ READ_PODCAST_DOMAIN: VALID.READ_PODCAST_DOMAIN });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("READ_PODCAST_TRANSCRIPTION_URL is required");
    expect(result.stderr).toContain("READ_PODCAST_GITHUB_REPO is required");
  });

  it("文档占位值、带 scheme 的域名与非 https 转录地址都被拒绝", () => {
    const placeholder = run({ ...VALID, READ_PODCAST_DOMAIN: "your-domain.example", READ_PODCAST_GITHUB_OWNER: "your-github-username" });
    expect(placeholder.status).toBe(1);
    expect(placeholder.stderr).toContain("READ_PODCAST_DOMAIN is still a documentation placeholder");
    expect(placeholder.stderr).toContain("READ_PODCAST_GITHUB_OWNER is still a documentation placeholder");

    const malformed = run({ ...VALID, READ_PODCAST_DOMAIN: "https://podcast.mydomain.net/", READ_PODCAST_TRANSCRIPTION_URL: "http://transcribe.mydomain.net" });
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain("must be a bare hostname");
    expect(malformed.stderr).toContain("must be an https:// URL");
  });

  it("从 READ_PODCAST_DEPLOY_ENV 指定的文件读取，环境变量优先", () => {
    const file = fileURLToPath(new URL("test/fixtures/deploy.env", ROOT));
    const result = run({ READ_PODCAST_DEPLOY_ENV: file, READ_PODCAST_GITHUB_REPO: "from-env" });
    expect(result.status).toBe(0);
    const args = JSON.parse(result.stdout) as string[];
    expect(args.slice(0, 3)).toEqual(["deploy", "--domain", "reader.fixture.net"]);
    expect(args).toContain("GITHUB_REPO:from-env");
    expect(args).toContain("GITHUB_OWNER:fixture-owner");
  });

  it("READ_PODCAST_TRANSCRIPTION_PROVIDER=dashscope：转录地址可省略，provider 注入为 var", () => {
    const result = run({ ...VALID, READ_PODCAST_TRANSCRIPTION_URL: "", READ_PODCAST_TRANSCRIPTION_PROVIDER: "dashscope" });
    expect(result.status).toBe(0);
    const args = JSON.parse(result.stdout) as string[];
    expect(args).toContain("--var");
    expect(args).toContain("TRANSCRIPTION_PROVIDER:dashscope");
    expect(args.join(" ")).not.toContain("TRANSCRIPTION_SERVICE_URL");
  });

  it("dashscope 下显式给出的转录地址仍然注入", () => {
    const result = run({ ...VALID, READ_PODCAST_TRANSCRIPTION_PROVIDER: "dashscope" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toContain("TRANSCRIPTION_SERVICE_URL:https://transcribe.mydomain.net");
  });

  it("无效的 provider 值被拒绝", () => {
    const result = run({ ...VALID, READ_PODCAST_TRANSCRIPTION_PROVIDER: "openai" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("READ_PODCAST_TRANSCRIPTION_PROVIDER must be self-hosted or dashscope");
  });
});

describe("仓库不含部署者自己的值", () => {
  it("wrangler.jsonc 不写 custom domain、D1 database_id 与个人 vars", () => {
    const config = read("wrangler.jsonc");
    for (const key of ["TRANSCRIPTION_SERVICE_URL", "GITHUB_OWNER", "GITHUB_REPO"]) {
      expect(config).toMatch(new RegExp(`"${key}"\\s*:\\s*""`));
    }
    expect(config).toContain('"GITHUB_PODCAST_PATH": "podcasts/transcripts"');
    expect(config).not.toMatch(/"routes"\s*:/);
    expect(config).not.toMatch(/"database_id"\s*:/);
    expect(config).toContain('"workers_dev": false');
    expect(config).toContain('"preview_urls": false');
  });

  it("CI 仅以非敏感变量启用部署，部署值来自 environment secrets", () => {
    const ci = read(".github/workflows/ci.yml");
    for (const name of [
      "DOMAIN", "TRANSCRIPTION_URL", "GITHUB_OWNER", "GITHUB_REPO",
      "GITHUB_BRANCH", "GITHUB_PATH", "TRANSCRIPTION_LANGUAGE",
      "TRANSCRIPTION_PROVIDER", "TIME_ZONE",
    ]) {
      expect(ci).toContain(`secrets.READ_PODCAST_${name}`);
      expect(ci).not.toContain(`vars.READ_PODCAST_${name}`);
    }
    expect(ci).toContain("vars.READ_PODCAST_DEPLOY == 'true'");
    expect(ci).toContain('base="https://${READ_PODCAST_DOMAIN}"');
    expect(ci).toContain("run: npm run deploy:production");
  });

  it("冒烟测试不在公开日志里输出跳转地址（含 Zero Trust 团队域名）", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("redirect_kind");
    // 只允许经 redirect_kind 分类后输出；去掉这种用法后，echo 行里不得再出现 $loc。
    const withoutClassified = ci.replaceAll('$(redirect_kind "$loc")', "");
    expect(withoutClassified).not.toMatch(/echo [^\n]*\$loc\b/);
    expect(withoutClassified).not.toMatch(/echo [^\n]*\$\{loc/);
  });

  it("冒烟测试的失败路径不输出目标地址，curl 错误信息不进日志", () => {
    const ci = read(".github/workflows/ci.yml");
    // 除了拼出 base 的那一行，echo 不得带 $base 或部署域名变量。
    expect(ci).not.toMatch(/echo [^\n]*\$base/);
    expect(ci).not.toMatch(/echo [^\n]*READ_PODCAST_DOMAIN/);
    // curl 不用 -S（show-error），且 stderr 被丢弃。
    const curlLine = ci.split("\n").find(line => line.includes("curl ") && line.includes("$base$1"));
    expect(curlLine).toBeDefined();
    expect(curlLine).not.toMatch(/curl -\w*S/);
    expect(curlLine).toContain("2>/dev/null");
  });

  it("npm run deploy:production 走 scripts/deploy.mjs，通用 deploy 走 scripts/deploy_community.mjs", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["deploy:production"]).toBe("node scripts/deploy.mjs");
    expect(pkg.scripts.deploy).toBe("node scripts/deploy_community.mjs");
    expect(execFileSync("git", ["check-ignore", ".deploy.env"], { cwd: fileURLToPath(ROOT), encoding: "utf-8" }).trim()).toBe(".deploy.env");
  });
});

describe("scripts/deploy_community.mjs", () => {
  it("opens workers.dev only in the temporary community config", () => {
    const source = read("wrangler.jsonc");
    const community = communityConfigFrom(source);
    expect(source).toContain('"workers_dev": false');
    expect(community).toContain('"workers_dev": true');
    expect(community).toContain('"preview_urls": false');
    expect(community).toContain('"/manage*"');
    expect(() => communityConfigFrom(community)).toThrow();
  });
  it("常规部署先执行 D1 remote migration 再执行 wrangler deploy", () => {
    const steps = buildCommunityDeploySteps([]);
    expect(steps).toEqual([
      { name: "migrate", command: "wrangler", args: ["d1", "migrations", "apply", "DB", "--remote"] },
      { name: "deploy", command: "wrangler", args: ["deploy"] },
    ]);
  });

  it("传入 --dry-run 时跳过 D1 remote migration，仅执行 wrangler deploy --dry-run", () => {
    const steps = buildCommunityDeploySteps(["--dry-run"]);
    expect(steps).toEqual([
      { name: "deploy", command: "wrangler", args: ["deploy", "--dry-run"] },
    ]);
  });

  it("子进程 --print-args 返回正确 JSON 执行计划", () => {
    const script = fileURLToPath(new URL("scripts/deploy_community.mjs", ROOT));
    const result = spawnSync(process.execPath, [script, "--print-args", "--dry-run"], { encoding: "utf-8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { name: "deploy", command: "wrangler", args: ["deploy", "--dry-run"] },
    ]);
  });
});
