# 发布流程（macOS）

面向维护者。目标是：**任何一次发布物，都能从一个干净的 tag 复现出来，并且普通
用户双击就能装。**

## 一次性准备

### 1. Developer ID 证书

需要 Apple Developer Program 会员资格（99 美元/年）。在 Xcode 或开发者后台创建
并下载 **Developer ID Application** 证书，导入钥匙串后确认能查到：

```bash
security find-identity -v -p codesigning
```

记下形如 `Developer ID Application: 你的名字 (TEAMID)` 的完整字符串。

### 2. 公证凭据

用 App 专用密码（appleid.apple.com 生成）保存一份 keychain profile，之后就不用
在命令行里出现密码：

```bash
xcrun notarytool store-credentials read-podcast-notary --apple-id <你的 Apple ID> --team-id <TEAMID>
```

### 3. 固定随包 FFmpeg

`scripts/ffmpeg-asset.env` 固定 FFmpeg 官方源码版本、地址与 SHA256。打包脚本在
本机用 `--disable-autodetect` 构建，不启用 `--enable-gpl` 或 `--enable-nonfree`，
然后只把 arm64 的 `ffmpeg`、`ffprobe` 放进 App：

```bash
shasum -a 256 下载到的归档
```

打包脚本会校验源码哈希、架构、许可证开关与所需的 segment muxer，任一不通过就
中止。换版本时三个值必须一起改。许可证边界见
[THIRD-PARTY-LICENSES.md](../THIRD-PARTY-LICENSES.md)。

## 每次发布

```bash
# 1. 定版：改 pyproject.toml 的 version，提交、合并
# 2. 从干净的工作树打 tag
git tag v1.0.0 && git push origin v1.0.0

# 3. 一致性门禁（工作区干净、HEAD 正好在 v<version> 上）
scripts/check_release.py

# 4. 发布构建：签名 + 公证 + staple + Gatekeeper 复核，全通过才写 dist/
export DEVELOPER_ID="Developer ID Application: 你的名字 (TEAMID)"
export NOTARY_PROFILE="read-podcast-notary"
bash scripts/pack_macos.sh

# 5. 校验发布物与版本、SHA256 是否一致
scripts/check_release.py --dist dist
```

没有 Developer ID 时可运行 `bash scripts/pack_macos.sh --preview`：它仍要求干净 tag、
固定 FFmpeg 与全部本地门禁，但只做 ad-hoc 签名、不公证。它可以作为明确标注的
预览版分发，用户首次启动必须右键 App 选择「打开」。

开发自用构建：`bash scripts/pack_macos.sh --dev`。它允许缺少固定 FFmpeg，不应上传 Release。

CI 只跑 `bash scripts/pack_macos.sh --check`：不下载、不构建，只挡住「固定资产常量
漏填/格式错」这类到发布当天才会暴露的问题。签名构建始终在维护者本机进行——把
Developer ID 证书放进 CI secrets 对单人项目不划算，等有稳定发布节奏再迁。

## 发布物

每个 Release 必须同时包含：

- `Read Podcast-<version>.dmg`（已签名、已公证、已 staple）
- `Read Podcast-<version>.dmg.sha256`
- Release Notes：系统要求、安装步骤、从 0.2 / 源码版升级、数据位置、回滚方式、
  联网与隐私边界、已知限制、SHA256、本次构建对应的 commit

发布前对照 [release-acceptance.md](release-acceptance.md) 跑完验收矩阵。

## 版本号与 tag

`scripts/check_release.py` 强制以下四者一致：`pyproject.toml` 的 `version`、
git tag（`v<version>`）、App 的 `CFBundleShortVersionString`、DMG 文件名。
预发布用 `1.0.0-rc.1` 这样的形式；容器镜像的 `latest` 只跟随正式版 tag，
预发布与 `main` 上的开发提交分别发到 `edge` 和 `sha-<commit>`。
