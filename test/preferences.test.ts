import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCloud, type Cloud } from "./helpers/cloud";
import {
  getPublicPreferences,
  getControlPreferences,
  putControlPreferences,
  loadUiPreferences,
  type UiPreferencesDto,
} from "../src/preferences";

function cloud(): Cloud {
  return makeCloud();
}

describe("UI Preferences API (云端偏好，本地零配置)", () => {
  it("默认返回标准排版与主题偏好配置", async () => {
    const c = cloud();
    const res = await getPublicPreferences(c.env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as UiPreferencesDto;

    expect(data.app_theme).toBe("auto");
    expect(data.reader_theme).toBe("follow");
    expect(data.font_preset).toBe("classical");
    expect(data.font_size).toBe(19);
    expect(data.line_height).toBe("normal");
    expect(data.margin_width).toBe("normal");
  });

  it("控制面 GET /preferences 与公共面返回一致", async () => {
    const c = cloud();
    const pubRes = await getPublicPreferences(c.env);
    const ctrlRes = await getControlPreferences(c.env);

    expect(pubRes.status).toBe(200);
    expect(ctrlRes.status).toBe(200);
    expect(await pubRes.json()).toEqual(await ctrlRes.json());
  });

  it("控制面 PUT /preferences 校验并持久化更新到 D1", async () => {
    const c = cloud();
    const patch = {
      app_theme: "dark",
      reader_theme: "warm",
      font_preset: "modern",
      font_size: 21,
      line_height: "relaxed",
      margin_width: "wide",
    };

    const req = new Request("https://edge/api/control/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });

    const res = await putControlPreferences(req, c.env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as UiPreferencesDto;

    expect(data.app_theme).toBe("dark");
    expect(data.reader_theme).toBe("warm");
    expect(data.font_preset).toBe("modern");
    expect(data.font_size).toBe(21);
    expect(data.line_height).toBe("relaxed");
    expect(data.margin_width).toBe("wide");
    expect(data.updated_at).toBeTruthy();

    // 再次从 D1 读取，确保持久化
    const persisted = await loadUiPreferences(c.env);
    expect(persisted.appTheme).toBe("dark");
    expect(persisted.readerTheme).toBe("warm");
    expect(persisted.fontSize).toBe(21);
  });

  it("支持部分字段增量更新，未提供字段保留原值", async () => {
    const c = cloud();
    const req = new Request("https://edge/api/control/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ font_size: 24, reader_theme: "green" }),
    });

    const res = await putControlPreferences(req, c.env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as UiPreferencesDto;

    expect(data.font_size).toBe(24);
    expect(data.reader_theme).toBe("green");
    expect(data.app_theme).toBe("auto");
    expect(data.font_preset).toBe("classical");
  });

  it("非法参数返回 400，拒绝写入半成品", async () => {
    const c = cloud();

    // 非法 app_theme
    await expect(
      putControlPreferences(
        new Request("https://edge/api/control/preferences", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ app_theme: "neon" }),
        }),
        c.env,
      ),
    ).rejects.toThrow();

    // 非法 reader_theme
    await expect(
      putControlPreferences(
        new Request("https://edge/api/control/preferences", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reader_theme: "rainbow" }),
        }),
        c.env,
      ),
    ).rejects.toThrow();

    // 超限 font_size
    await expect(
      putControlPreferences(
        new Request("https://edge/api/control/preferences", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ font_size: 50 }),
        }),
        c.env,
      ),
    ).rejects.toThrow();
  });
});
