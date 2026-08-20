#!/usr/bin/env bash
# 把 Read Podcast 打包成一个 macOS App（仅 Apple Silicon）。
#
# 做法参考了 QwenPaw 等项目的"轻量版"桌面打包方式：不用 PyInstaller 冻结
# Python（mlx-whisper 这类带 Metal/Accelerate 原生扩展的包冻结后容易出问题），
# 而是把一个可重定位的独立 CPython（python-build-standalone）连同按 uv.lock
# 精确安装好的依赖，整个塞进 .app/Contents/Resources，再用一个 bash 启动器
# 设置 PYTHONHOME 后原地跑 —— 等价于把 start.sh 的流程包进一个可双击的壳。
#
# 产物：dist/Read Podcast.app（未公证，仅供本机运行 / 信任的人之间分发）。
# 用法：bash scripts/pack_macos.sh
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
DIST_DIR="${DIST_DIR:-$REPO_ROOT/dist}"
APP_NAME="Read Podcast"
APP_DIR="$DIST_DIR/$APP_NAME.app"
BUNDLE_ID="${READ_PODCAST_BUNDLE_ID:-com.xielevi.read-podcast}"
PYTHON_XY="3.12"
PBS_RELEASE="${READ_PODCAST_PBS_RELEASE:-latest}"

info() { printf '\033[1;34m▶ %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] || \
  die "本工具只支持 Apple 芯片的 Mac（M1/M2/M3/M4）。"
command -v uv >/dev/null 2>&1 || die "找不到 uv，请先运行 ./scripts/install.sh"

VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' pyproject.toml | head -1)
[ -n "$VERSION" ] || die "无法从 pyproject.toml 读取版本号。"

# pyproject 的版本号只在发版时才动，光看它分不清一个 .app 到底打的是哪次提交
# （很容易误以为构建产物很旧）。把 git 描述一起写进 CFBundleVersion，
# 「显示简介」里就能看到确切来源。
BUILD_REV=$(git describe --tags --always --dirty 2>/dev/null || echo "unknown")
BUILD_DATE=$(date +%Y-%m-%d)

info "清理旧的构建产物…"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
RES="$APP_DIR/Contents/Resources"

# --- Step 1: 下载可重定位的独立 CPython 运行时 -----------------------------
info "获取独立 Python ${PYTHON_XY} 运行时（aarch64-apple-darwin）…"
if [ "$PBS_RELEASE" = "latest" ]; then
  RELEASE_URL="https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest"
else
  RELEASE_URL="https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/${PBS_RELEASE}"
fi
ASSET_URL=$(curl -fsSL "$RELEASE_URL" | python3 -c '
import json, re, sys
data = json.load(sys.stdin)
pattern = re.compile(r"^cpython-'"$PYTHON_XY"'\.\d+\+\d+-aarch64-apple-darwin-install_only\.tar\.gz$")
for asset in data.get("assets", []):
    if pattern.match(asset.get("name", "")):
        print(asset["browser_download_url"])
        break
')
[ -n "$ASSET_URL" ] || die "在 python-build-standalone release 里找不到匹配的 CPython 构建（release=$PBS_RELEASE）。"
curl -fsSL "$ASSET_URL" -o "$DIST_DIR/_python-runtime.tar.gz"
tar -xzf "$DIST_DIR/_python-runtime.tar.gz" -C "$RES"
rm -f "$DIST_DIR/_python-runtime.tar.gz"
mv "$RES/python" "$RES/python-runtime"
PYTHON_BIN="$RES/python-runtime/bin/python3"
[ -x "$PYTHON_BIN" ] || die "解压后找不到 Python 可执行文件：$PYTHON_BIN"
ok "Python 运行时已就绪"

# --- Step 2: 按 uv.lock 精确安装依赖到该运行时里 ----------------------------
# mlx-whisper 的 METADATA 声明了一批这个 App 根本走不到的重依赖，逐个说明：
#
#   torch / sympy / networkx （~620MB）
#     torch 只被 mlx_whisper/torch_whisper.py 用到，而那是一份对照用的参考
#     实现，包里没有任何地方 import 它；真正的推理路径全程走 mlx.core。
#
#   numba / llvmlite / scipy （~204MB）
#     只被 mlx_whisper/timing.py 用到（两个 @numba.jit 装饰器 + 一次
#     scipy.signal.medfilt），而 timing 只服务于 add_word_timestamps ——
#     词级时间戳。Read Podcast 的流水线从不开这个开关，转录结果里也不消费
#     词级时间戳。下面 Step 2c 会把它的 import 改成惰性，真要用时才报错。
#
# 用 --no-deps 严格按 uv.lock 装，再排除上面这些，功能不受影响（每次构建结束
# 都会跑一次真实音频转写验证）。
info "按 uv.lock 安装依赖（含 mlx-whisper）…"
uv export --extra mlx --no-dev --frozen --no-hashes -o "$DIST_DIR/_requirements.lock.txt"
grep -vE '^(torch|sympy|networkx|numba|llvmlite|scipy)==' "$DIST_DIR/_requirements.lock.txt" \
  > "$DIST_DIR/_requirements.trimmed.txt"
"$PYTHON_BIN" -m ensurepip --upgrade >/dev/null 2>&1 || true
"$PYTHON_BIN" -m pip install --no-deps --no-cache-dir --quiet -r "$DIST_DIR/_requirements.trimmed.txt"
rm -f "$DIST_DIR/_requirements.lock.txt" "$DIST_DIR/_requirements.trimmed.txt"
ok "依赖安装完成"

# --- Step 2c: 让 mlx-whisper 的词级时间戳依赖变成惰性 ------------------------
# transcribe.py 在模块顶层 `from .timing import add_word_timestamps`，而 timing
# 顶层就 import numba/scipy —— 只要不动它，那 204MB 就必须跟着进包。实际调用点
# 只有一处，且已经在 `if word_timestamps:` 里，所以把 import 挪进去即可。
#
# 这是对第三方包打的补丁，所以下面用严格的锚点匹配：mlx-whisper 升级后只要代码
# 形状变了就直接构建失败，不会悄悄失效（这正是不敢乱改 vendored 代码的顾虑）。
info "给 mlx-whisper 打惰性 import 补丁…"
SITE_PACKAGES="$RES/python-runtime/lib/python${PYTHON_XY}/site-packages"
"$PYTHON_BIN" - "$SITE_PACKAGES/mlx_whisper/transcribe.py" <<'PATCH'
import sys
from pathlib import Path

target = Path(sys.argv[1])
source = target.read_text(encoding="utf-8")

TOP_LEVEL_IMPORT = "from .timing import add_word_timestamps\n"
CALL_SITE = "                if word_timestamps:\n                    add_word_timestamps(\n"

for anchor, label in ((TOP_LEVEL_IMPORT, "顶层 import"), (CALL_SITE, "调用点")):
    if source.count(anchor) != 1:
        raise SystemExit(
            f"mlx-whisper 补丁失败：预期恰好出现一次的{label}没找到（或不止一处）。\n"
            f"多半是 mlx-whisper 升级后代码变了，请重新核对 timing/word_timestamps "
            f"的调用链，确认能否继续排除 numba/llvmlite/scipy。"
        )

source = source.replace(
    TOP_LEVEL_IMPORT,
    "# add_word_timestamps 改为惰性导入（打包时由 scripts/pack_macos.sh 修改）：\n"
    "# 它依赖的 numba/llvmlite/scipy 有 ~204MB，而本 App 从不开启词级时间戳。\n",
)
source = source.replace(
    CALL_SITE,
    "                if word_timestamps:\n"
    "                    from .timing import add_word_timestamps\n\n"
    "                    add_word_timestamps(\n",
)
target.write_text(source, encoding="utf-8")
print("  已改为惰性导入")
PATCH
ok "补丁完成"

# --- Step 2d: 瘦身 ----------------------------------------------------------
info "清理运行时用不到的文件…"
# pip/setuptools 只在上一步安装过程中用得上，App 运行时不会再调用它们。
rm -rf "$SITE_PACKAGES"/pip "$SITE_PACKAGES"/pip-*.dist-info \
       "$SITE_PACKAGES"/setuptools "$SITE_PACKAGES"/setuptools-*.dist-info \
       "$SITE_PACKAGES"/pkg_resources
# 这是个网页应用，不用 Tk GUI，也不需要 C 扩展头文件、man 手册和 2to3/IDLE。
RUNTIME_LIB="$RES/python-runtime/lib"
rm -rf "$RES/python-runtime/include" "$RES/python-runtime/share" \
       "$RUNTIME_LIB"/tcl* "$RUNTIME_LIB"/tk* "$RUNTIME_LIB"/libtcl* \
       "$RUNTIME_LIB"/libtk* "$RUNTIME_LIB"/itcl* "$RUNTIME_LIB"/thread* \
       "$RUNTIME_LIB"/pkgconfig \
       "$RUNTIME_LIB/python${PYTHON_XY}"/{idlelib,tkinter,turtledemo,lib2to3,pydoc_data,ensurepip} \
       "$RUNTIME_LIB/python${PYTHON_XY}"/test "$RUNTIME_LIB/python${PYTHON_XY}"/turtle.py
find "$RES/python-runtime/bin" -maxdepth 1 \
  \( -name "2to3*" -o -name "idle3*" -o -name "pydoc3*" -o -name "pip*" \) -delete
find "$RES/python-runtime" -type d -name "__pycache__" -prune -exec rm -rf {} +
find "$RES/python-runtime" -type d -name "tests" -path "*/site-packages/*" -prune -exec rm -rf {} + 2>/dev/null || true
find "$RES/python-runtime" -type f \( -name "*.dylib" -o -name "*.so" \) \
  -exec strip -x {} + 2>/dev/null || true
ok "瘦身完成（$(du -sh "$RES/python-runtime" | cut -f1)）"

# --- Step 3: 拷贝应用代码（和 Dockerfile 拷贝的内容一致）--------------------
info "拷贝应用代码…"
cp -R app "$RES/app"
cp -R modules "$RES/modules"
cp -R scripts "$RES/scripts"
# 打包脚本自身对 App 没用，跟进去只会让人误以为能在 App 里重新构建。
rm -f "$RES/scripts/pack_macos.sh"
ok "代码已拷贝"

# --- Step 3b: 验证瘦身后的运行时 + 应用代码仍然可用 --------------------------
# 上面删了不少东西，又改了第三方包，这里当场把整套 import 跑一遍，
# 出问题就地失败，而不是等用户双击时才发现。
info "验证打包结果能正常 import…"
(cd "$RES" && PYTHONHOME="$RES/python-runtime" PYTHONPATH="$RES" \
  "$PYTHON_BIN" -c "
import mlx_whisper, fastapi, uvicorn, httpx, aiosqlite, feedparser, yaml, requests
import app.standalone, scripts.mlx_backend
for banned in ('torch', 'numba', 'scipy', 'llvmlite'):
    assert banned not in __import__('sys').modules, banned + ' 竟然被导入了'
print('  import 全部通过，且未触及已排除的重依赖')
") || die "打包结果无法正常 import，构建中止。"
ok "校验通过"

# --- Step 4: 生成启动器 -----------------------------------------------------
info "生成启动器…"
cat > "$APP_DIR/Contents/MacOS/$APP_NAME" <<'LAUNCHER'
#!/usr/bin/env bash
# Read Podcast 桌面启动器：拉起语音转录后端（MLX）与网页应用，打开浏览器。
# 逻辑照搬 scripts/start.sh，只是把 `uv run` 换成了打包进 App 的独立 Python。
set -euo pipefail

RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
PYTHON_BIN="$RES/python-runtime/bin/python3"
APP_SUPPORT="$HOME/Library/Application Support/Read Podcast"
LOG="$APP_SUPPORT/app.log"

mkdir -p "$APP_SUPPORT/config" "$APP_SUPPORT/workspace"
exec >>"$LOG" 2>&1
echo "=== $(date) Read Podcast starting ==="

# app/database.py 等模块把数据写在 PROJECT_ROOT/workspace 下（PROJECT_ROOT
# 就是这里的 Resources）。用软链接把它重定向到 Application Support，这样
# App 本体保持只读、可随时整体替换/删除，数据不会跟着丢。
if [ ! -L "$RES/workspace" ]; then
  rm -rf "$RES/workspace"
  ln -s "$APP_SUPPORT/workspace" "$RES/workspace"
fi

cd "$RES"
unset PYTHONPATH
export PYTHONHOME="$RES/python-runtime"
export PYTHONNOUSERSITE=1
export PYTHONPATH="$RES"
export PATH="$RES/python-runtime/bin:$PATH"
export READ_PODCAST_CONFIG="$APP_SUPPORT/config/config.yaml"

if ! command -v ffmpeg >/dev/null 2>&1; then
  osascript -e 'display alert "缺少 ffmpeg" message "Read Podcast 需要 ffmpeg 处理音频。请打开终端运行：\n\nbrew install ffmpeg\n\n（没有 Homebrew？先到 https://brew.sh 安装）" as critical' || true
  echo "ERROR: ffmpeg 未安装，已提示用户，退出。"
  exit 1
fi

APP_PORT="${READ_PODCAST_PORT:-28000}"
MLX_PORT="${READ_PODCAST_MLX_PORT:-21567}"

# 端口被占时必须当场停下：否则后面的健康检查会连上「别人」（比如 start.sh 起的
# 开发实例，或另一份已在运行的 App），浏览器打开的是那一个，而本 App 的 uvicorn
# 其实绑定失败了 —— 现象就是「明明重新构建了，界面却还是旧的」，极难排查。
for _entry in "${APP_PORT}:网页应用" "${MLX_PORT}:语音转录后端"; do
  _port="${_entry%%:*}"
  _label="${_entry##*:}"
  if lsof -nP -iTCP:"${_port}" -sTCP:LISTEN >/dev/null 2>&1; then
    _who=$(lsof -nP -iTCP:"${_port}" -sTCP:LISTEN -Fc 2>/dev/null | sed -n 's/^c//p' | head -1)
    osascript -e "display alert \"端口 ${_port} 已被占用\" message \"${_label}要用的端口 ${_port} 已被另一个程序（${_who:-未知}）占用。\n\n多半是 scripts/start.sh 起的开发实例，或另一份 Read Podcast 还在运行。请先关掉它再打开本 App，否则你看到的会是那一个实例的界面。\" as critical" || true
    echo "ERROR: 端口 ${_port}（${_label}）已被 ${_who:-未知} 占用，退出。"
    exit 1
  fi
done

export READ_PODCAST_MLX_HOST=127.0.0.1
export READ_PODCAST_TRANSCRIPTION_API_URL="http://127.0.0.1:${MLX_PORT}/transcribe"
export READ_PODCAST_TRANSCRIPTION_SHARED_AUDIO_ROOT=""

if [ ! -f "$READ_PODCAST_CONFIG" ]; then
  cat > "$READ_PODCAST_CONFIG" <<YAML
# 你的配置就写在这个文件里；也可以用网页右上角的「设置」面板改，两者
# 作用于同一份配置。可用选项见内置默认值：
# Contents/Resources/modules/config.default.yaml（只读参考，别直接改它）。
# 密钥不写这里，用网页「设置」面板保存（会写到同目录的 secrets.env）。
transcription:
  api_url: http://127.0.0.1:${MLX_PORT}/transcribe
  shared_audio_root: ""
YAML
fi

MLX_PID=""
cleanup() {
  echo "正在停止服务…"
  [ -n "$MLX_PID" ] && kill "$MLX_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "启动语音转录后端（首次会下载模型，可能需要几分钟）…"
"$PYTHON_BIN" -m scripts.mlx_backend &
MLX_PID=$!

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${MLX_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  kill -0 "$MLX_PID" 2>/dev/null || { echo "转录后端启动失败，见上方日志。"; exit 1; }
  sleep 1
done

( sleep 2; open "http://127.0.0.1:${APP_PORT}/" ) &

echo "启动网页应用，监听 127.0.0.1:${APP_PORT}"
"$PYTHON_BIN" -m uvicorn app.standalone:app --host 127.0.0.1 --port "$APP_PORT"
LAUNCHER
chmod +x "$APP_DIR/Contents/MacOS/$APP_NAME"
ok "启动器已生成"

# --- Step 5: Info.plist -----------------------------------------------------
info "生成 Info.plist…"
cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${BUILD_REV}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleGetInfoString</key><string>${VERSION} (${BUILD_REV}, 构建于 ${BUILD_DATE})</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.5</string>
</dict>
</plist>
PLIST
ok "Info.plist 已生成"

# --- Step 6: ad-hoc 签名 -----------------------------------------------------
info "ad-hoc 签名（本机运行足够；分发/公证见下方提示）…"
codesign --force --deep --sign - "$APP_DIR"
ok "签名完成"

echo
ok "构建完成：$APP_DIR"
echo "测试运行： open \"$APP_DIR\""
echo
echo "提示："
echo "  · 这是 ad-hoc 签名，不是 Apple Developer ID 签名/公证。给别人分发前，"
echo "    对方首次打开需要右键 → 打开 绕过 Gatekeeper（或使用付费开发者证书重签）。"
echo "  · 如需正式签名分发，把这一步换成："
echo '      codesign --force --deep --sign "Developer ID Application: 你的名字 (TEAMID)" "'"$APP_DIR"'"'
echo "    然后走 notarytool 公证。"
