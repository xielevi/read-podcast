/**
 * 部署可移植性：仓库本身不带任何部署者自己的值，部署值只经 scripts/deploy.mjs 注入。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

  it("CI 从仓库变量读取部署值，没有设置时跳过部署", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("vars.READ_PODCAST_TRANSCRIPTION_URL");
    expect(ci).toContain("vars.READ_PODCAST_GITHUB_OWNER");
    expect(ci).toContain("vars.READ_PODCAST_GITHUB_REPO");
    expect(ci).toMatch(/if: .*vars\.READ_PODCAST_DOMAIN != ''/);
    expect(ci).toContain('base="https://${READ_PODCAST_DOMAIN}"');
    expect(ci).toContain("run: npm run deploy");
  });

  it("npm run deploy 走 scripts/deploy.mjs", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.deploy).toBe("node scripts/deploy.mjs");
    expect(execFileSync("git", ["check-ignore", ".deploy.env"], { cwd: fileURLToPath(ROOT), encoding: "utf-8" }).trim()).toBe(".deploy.env");
  });
});
