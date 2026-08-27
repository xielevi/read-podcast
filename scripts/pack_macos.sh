#!/usr/bin/env bash
# 把 Read Podcast 打包成一个 macOS App + dmg 安装镜像（仅 Apple Silicon）。
#
# 做法参考了 QwenPaw 等项目的"轻量版"桌面打包方式：不用 PyInstaller 冻结
# Python（mlx-whisper 这类带 Metal/Accelerate 原生扩展的包冻结后容易出问题），
# 而是把一个可重定位的独立 CPython（python-build-standalone）连同按 uv.lock
# 精确安装好的依赖，整个塞进 .app/Contents/Resources，再用一个 bash 启动器
# 设置 PYTHONHOME 后原地跑 —— 等价于把 start.sh 的流程包进一个可双击的壳。
# 最后用系统自带的 hdiutil 把 .app 连同一个 /Applications 快捷方式封进 dmg。
#
# 产物：dist/Read Podcast.app、dist/Read Podcast-<version>.dmg 与 SHA256 文件。
# App 为 ad-hoc 签名；dmg 未签名、未公证，仅供本机运行 / 信任的人之间分发。
# 用法：bash scripts/pack_macos.sh
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
DIST_DIR="${DIST_DIR:-$REPO_ROOT/dist}"
APP_NAME="Read Podcast"
FINAL_APP_DIR="$DIST_DIR/$APP_NAME.app"
BUNDLE_ID="${READ_PODCAST_BUNDLE_ID:-com.xielevi.read-podcast}"
PYTHON_XY="3.12"
PYTHON_VERSION="3.12.14"
PBS_RELEASE="20260814"
PBS_ASSET="cpython-${PYTHON_VERSION}+${PBS_RELEASE}-aarch64-apple-darwin-install_only.tar.gz"
PBS_SHA256="4572133a5542f306b9bdb155da5800f9e38950cd0a98d469b832ce256fe299ea"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${PBS_ASSET}"

info() { printf '\033[1;34m▶ %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] || \
  die "本工具只支持 Apple 芯片的 Mac（M1/M2/M3/M4）。"
command -v uv >/dev/null 2>&1 || die "找不到 uv，请先运行 ./scripts/install.sh"
for tool in curl shasum codesign hdiutil; do
  command -v "$tool" >/dev/null 2>&1 || die "缺少构建工具：$tool"
done
mkdir -p "$DIST_DIR"

BUILD_DIR=$(mktemp -d "$DIST_DIR/.pack-macos.XXXXXX")
cleanup_build() { rm -rf "$BUILD_DIR"; }
trap cleanup_build EXIT
APP_DIR="$BUILD_DIR/$APP_NAME.app"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
RES="$APP_DIR/Contents/Resources"

VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' pyproject.toml | head -1)
[ -n "$VERSION" ] || die "无法从 pyproject.toml 读取版本号。"

# CFBundleVersion 只能是「至多三段、每段不超过四位」的数字版本号；Git 描述另存到
# 显示信息和自定义字段。有 Git 历史时用提交计数（单调递增的纯整数），否则退回
# 到 YYYY.MM.DD —— 三段、每段 ≤4 位，仍是合法的 CFBundleVersion（12 位的
# date +%Y%m%d%H%M 单段超过四位，会被 bundle 校验/分发工具拒绝）。
BUILD_REV=$(git describe --tags --always --dirty 2>/dev/null || echo "unknown")
BUILD_NUMBER=$(git rev-list --count HEAD 2>/dev/null || date +%Y.%m.%d)
BUILD_DATE=$(date +%Y-%m-%d)

# --- Step 1: 下载可重定位的独立 CPython 运行时 -----------------------------
info "获取固定的独立 Python ${PYTHON_VERSION} 运行时（release ${PBS_RELEASE}）…"
RUNTIME_ARCHIVE="$BUILD_DIR/$PBS_ASSET"
curl -fL --retry 3 --retry-delay 2 "$PBS_URL" -o "$RUNTIME_ARCHIVE"
ACTUAL_SHA256=$(shasum -a 256 "$RUNTIME_ARCHIVE" | awk '{print $1}')
[ "$ACTUAL_SHA256" = "$PBS_SHA256" ] || \
  die "Python 运行时 SHA256 不匹配：expected=$PBS_SHA256 actual=$ACTUAL_SHA256"
tar -xzf "$RUNTIME_ARCHIVE" -C "$RES"
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
# 用 --no-deps 严格按 uv.lock 装，再排除上面这些。默认构建会验证完整 import 链；
# 如设置 READ_PODCAST_PACK_SMOKE_AUDIO，还会用该音频执行一次真实 MLX 转写。
info "按 uv.lock 安装依赖（含 mlx-whisper）…"
REQUIREMENTS_TRIMMED="$BUILD_DIR/requirements.trimmed.txt"
uv export --extra mlx --no-dev --frozen \
  --prune torch \
  --prune sympy \
  --prune networkx \
  --prune numba \
  --prune llvmlite \
  --prune scipy \
  -o "$REQUIREMENTS_TRIMMED"
"$PYTHON_BIN" -m ensurepip --upgrade >/dev/null 2>&1 || true
"$PYTHON_BIN" -m pip install \
  --require-hashes --no-deps --no-cache-dir --quiet \
  -r "$REQUIREMENTS_TRIMMED"
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
# 源码目录可能带有宿主 Python 生成的缓存；它们不可进入可复现产物。
find "$RES/app" "$RES/modules" "$RES/scripts" -type d -name "__pycache__" -prune -exec rm -rf {} +
find "$RES/app" "$RES/modules" "$RES/scripts" -type f -name "*.pyc" -delete
ok "代码已拷贝"

# --- Step 3b: 验证瘦身后的运行时 + 应用代码仍然可用 --------------------------
# 上面删了不少东西，又改了第三方包，这里当场把整套 import 跑一遍，
# 出问题就地失败，而不是等用户双击时才发现。
info "验证打包结果能正常 import，且只写临时数据目录…"
SMOKE_DATA_DIR="$BUILD_DIR/smoke-data"
(cd "$RES" && PYTHONDONTWRITEBYTECODE=1 PYTHONHOME="$RES/python-runtime" PYTHONPATH="$RES" \
  READ_PODCAST_CONFIG="$BUILD_DIR/smoke-config.yaml" READ_PODCAST_DATA_DIR="$SMOKE_DATA_DIR" \
  "$PYTHON_BIN" -c "
import mlx_whisper, fastapi, uvicorn, httpx, aiosqlite, feedparser, yaml, requests
import app.standalone, scripts.mlx_backend
import os
from pathlib import Path
from modules.config import settings
assert settings.DATA_DIR == Path(os.environ['READ_PODCAST_DATA_DIR'])
for banned in ('torch', 'numba', 'scipy', 'llvmlite'):
    assert banned not in __import__('sys').modules, banned + ' 竟然被导入了'
print('  import 全部通过，且未触及已排除的重依赖')
") || die "打包结果无法正常 import，构建中止。"
[ -z "$(find "$RES/app" "$RES/modules" "$RES/scripts" -type f -name '*.pyc' -print -quit)" ] || \
  die "应用源码目录产生了 .pyc，构建不可复现。"
ok "校验通过"

if [ -n "${READ_PODCAST_PACK_SMOKE_AUDIO:-}" ]; then
  [ -f "$READ_PODCAST_PACK_SMOKE_AUDIO" ] || die "真实转写测试音频不存在：$READ_PODCAST_PACK_SMOKE_AUDIO"
  info "执行真实 MLX 音频转写验证…"
  (cd "$RES" && PYTHONDONTWRITEBYTECODE=1 PYTHONHOME="$RES/python-runtime" PYTHONPATH="$RES" \
    READ_PODCAST_CONFIG="$BUILD_DIR/smoke-config.yaml" READ_PODCAST_DATA_DIR="$SMOKE_DATA_DIR" \
    "$PYTHON_BIN" - "$READ_PODCAST_PACK_SMOKE_AUDIO" <<'SMOKE'
import sys
from pathlib import Path
from scripts.mlx_backend import MODEL, _transcribe_sync

result = _transcribe_sync(
    Path(sys.argv[1]),
    MODEL,
    {"word_timestamps": False, "verbose": False},
    None,
)
if not isinstance(result, dict) or not str(result.get("text", "")).strip():
    raise SystemExit("真实转写没有返回文本")
print("  真实转写通过")
SMOKE
  ) || die "真实 MLX 音频转写验证失败。"
fi

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

cd "$RES"
unset PYTHONPATH
export PYTHONHOME="$RES/python-runtime"
export PYTHONNOUSERSITE=1
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="$RES"
export PATH="$RES/python-runtime/bin:$PATH"
export READ_PODCAST_CONFIG="$APP_SUPPORT/config/config.yaml"
export READ_PODCAST_DATA_DIR="$APP_SUPPORT/workspace"

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

MLX_READY=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${MLX_PORT}/health" >/dev/null 2>&1; then
    MLX_READY=1
    break
  fi
  kill -0 "$MLX_PID" 2>/dev/null || { echo "转录后端启动失败，见上方日志。"; exit 1; }
  sleep 1
done
[ "$MLX_READY" -eq 1 ] || { echo "转录后端在 60 秒内未就绪。"; exit 1; }

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
  <key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleGetInfoString</key><string>${VERSION} (${BUILD_REV}, 构建于 ${BUILD_DATE})</string>
  <key>ReadPodcastGitRevision</key><string>${BUILD_REV}</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.5</string>
</dict>
</plist>
PLIST
ok "Info.plist 已生成"

# --- Step 6: ad-hoc 签名 -----------------------------------------------------
info "ad-hoc 签名（本机运行足够；分发/公证见下方提示）…"
codesign --force --deep --sign - "$APP_DIR"
codesign --verify --deep --strict --verbose=2 "$APP_DIR"
ok "签名完成"

# --- Step 7: 打包成 dmg ------------------------------------------------------
# 纯用系统自带的 hdiutil，不引入 create-dmg 之类的第三方依赖：一个 App 图标 +
# 一个指向 /Applications 的快捷方式，拖拽安装，够用。
info "打包成 dmg 安装镜像…"
DMG_NAME="${APP_NAME}-${VERSION}.dmg"
DMG_PATH="$BUILD_DIR/$DMG_NAME"
STAGING_DIR="$BUILD_DIR/dmg-staging"
mkdir -p "$STAGING_DIR"
cp -R "$APP_DIR" "$STAGING_DIR/"
ln -s /Applications "$STAGING_DIR/Applications"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGING_DIR" -fs HFS+ -format UDZO -ov "$DMG_PATH" >/dev/null
hdiutil verify "$DMG_PATH" >/dev/null
ok "dmg 已生成（$(du -sh "$DMG_PATH" | cut -f1)）"

# 所有验证通过后才替换公开产物，构建中途失败不会破坏上一版。
FINAL_DMG_PATH="$DIST_DIR/$DMG_NAME"
FINAL_SHA_PATH="$FINAL_DMG_PATH.sha256"
rm -rf "$FINAL_APP_DIR"
rm -f "$FINAL_DMG_PATH" "$FINAL_SHA_PATH"
mv "$APP_DIR" "$FINAL_APP_DIR"
mv "$DMG_PATH" "$FINAL_DMG_PATH"
(cd "$DIST_DIR" && shasum -a 256 "$DMG_NAME" > "$DMG_NAME.sha256")
codesign --verify --deep --strict --verbose=2 "$FINAL_APP_DIR"
hdiutil verify "$FINAL_DMG_PATH" >/dev/null

echo
ok "构建完成：$FINAL_APP_DIR"
ok "安装镜像：$FINAL_DMG_PATH"
ok "校验文件：$FINAL_SHA_PATH"
echo "测试运行： open \"$FINAL_APP_DIR\""
echo "测试安装： open \"$FINAL_DMG_PATH\"（打开后把 App 拖进 Applications）"
echo
echo "提示："
echo "  · App 是 ad-hoc 签名；dmg 当前未签名，二者均未公证。给别人分发前，对方首次"
echo "    打开需要右键 → 打开 绕过 Gatekeeper（或使用付费开发者证书重签）。"
echo "  · 如需正式签名分发，把 Step 6 的签名命令换成："
echo '      codesign --force --deep --sign "Developer ID Application: 你的名字 (TEAMID)" "'"$FINAL_APP_DIR"'"'
echo "    dmg 生成后再对 dmg 本身签名一次，然后走 notarytool 公证："
echo '      codesign --force --sign "Developer ID Application: 你的名字 (TEAMID)" "'"$FINAL_DMG_PATH"'"'
echo '      xcrun notarytool submit "'"$FINAL_DMG_PATH"'" --keychain-profile <profile> --wait'
echo '      xcrun stapler staple "'"$FINAL_DMG_PATH"'"'
