#!/usr/bin/env bash
# 安装固定版本 DSH 运行时，并注册为 macOS launchd 用户守护。
# 用法：bash install.sh
set -euo pipefail

LABEL="org.example.dsh-web"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_SRC="$SCRIPT_DIR/org.example.dsh-web.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${DSH_WEB_PORT:-3080}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
NPM_BIN="${NPM_BIN:-$(command -v npm)}"
RUNTIME_MANIFEST="$SCRIPT_DIR/runtime-package.json"
RUNTIME_LOCK="$SCRIPT_DIR/runtime-package-lock.json"
RUNTIME_ROOT="${DSH_HOME:-$HOME/.dsh}/runtime"
RUNTIME_VERSIONS="$RUNTIME_ROOT/versions"
RUNTIME_CURRENT="$RUNTIME_ROOT/current"
STAGE=""
PREVIOUS_PLIST=""

cleanup() {
  if [[ -n "$STAGE" && -d "$STAGE" ]]; then
    rm -rf -- "$STAGE"
  fi
  if [[ -n "$PREVIOUS_PLIST" && -f "$PREVIOUS_PLIST" ]]; then
    rm -f -- "$PREVIOUS_PLIST"
  fi
}
trap cleanup EXIT

for required in "$NODE_BIN" "$NPM_BIN" "$RUNTIME_MANIFEST" "$RUNTIME_LOCK" "$PLIST_SRC"; do
  if [[ ! -e "$required" ]]; then
    echo "!! 缺少安装依赖：$required" >&2
    exit 1
  fi
done

RUNTIME_VERSION="$($NODE_BIN -e 'const p = require(process.argv[1]); process.stdout.write(p.dependencies["@deepseek-ai/dsh"])' "$RUNTIME_MANIFEST")"
LOCK_DIGEST="$(shasum -a 256 "$RUNTIME_LOCK" | awk '{ print substr($1, 1, 12) }')"
DEPLOY_ID="$RUNTIME_VERSION-$LOCK_DIGEST-$(date +%Y%m%d%H%M%S)"
DEPLOY_DIR="$RUNTIME_VERSIONS/$DEPLOY_ID"
PREVIOUS_TARGET="$(readlink "$RUNTIME_CURRENT" 2>/dev/null || true)"

mkdir -p "$RUNTIME_VERSIONS"
STAGE="$(mktemp -d "$RUNTIME_ROOT/.install.XXXXXX")"
cp "$RUNTIME_MANIFEST" "$STAGE/package.json"
cp "$RUNTIME_LOCK" "$STAGE/package-lock.json"

echo "==> 安装锁定运行时 @deepseek-ai/dsh@$RUNTIME_VERSION"
"$NPM_BIN" ci --prefix "$STAGE" --omit=dev --no-audit --no-fund

INSTALLED_VERSION="$($NODE_BIN -e 'const p = require(process.argv[1]); process.stdout.write(p.version)' "$STAGE/node_modules/@deepseek-ai/dsh/package.json")"
if [[ "$INSTALLED_VERSION" != "$RUNTIME_VERSION" ]]; then
  echo "!! 运行时版本不匹配：期望 ${RUNTIME_VERSION}，实际 ${INSTALLED_VERSION}" >&2
  exit 1
fi
"$NODE_BIN" --check "$STAGE/node_modules/@deepseek-ai/dsh/lib/bin.js"
"$NODE_BIN" "$STAGE/node_modules/@deepseek-ai/dsh/lib/bin.js" --help >/dev/null

mv "$STAGE" "$DEPLOY_DIR"
STAGE=""

# 新运行时准备好之后再停止旧服务，把停机窗口限制在 launchd 重载阶段。
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for _ in {1..10}; do
  if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "!! 端口 $PORT 仍被其他进程占用，未切换运行时。" >&2
  exit 1
fi

if [[ -f "$PLIST_DST" ]]; then
  PREVIOUS_PLIST="$(mktemp "${TMPDIR:-/tmp}/dsh-web-plist.XXXXXX")"
  cp "$PLIST_DST" "$PREVIOUS_PLIST"
fi

ln -sfn "$DEPLOY_DIR" "$RUNTIME_CURRENT"
mkdir -p "$HOME/Library/LaunchAgents"
WORKDIR="${DSH_WORKDIR:-$HOME}"
DSH_BIN="$RUNTIME_CURRENT/node_modules/@deepseek-ai/dsh/lib/bin.js"
sed \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  -e "s|__DSH_BIN__|$DSH_BIN|g" \
  -e "s|__WORKDIR__|$WORKDIR|g" \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__PATH__|$PATH|g" \
  "$PLIST_SRC" > "$PLIST_DST"
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"

HEALTHY=0
for _ in {1..30}; do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done

if [[ "$HEALTHY" -ne 1 ]]; then
  echo "!! 新运行时启动失败，最近日志：" >&2
  tail -n 80 "${DSH_HOME:-$HOME/.dsh}/dsh-web.log" >&2 || true
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  if [[ -n "$PREVIOUS_TARGET" && -e "$PREVIOUS_TARGET" && -n "$PREVIOUS_PLIST" ]]; then
    ln -sfn "$PREVIOUS_TARGET" "$RUNTIME_CURRENT"
    cp "$PREVIOUS_PLIST" "$PLIST_DST"
    launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" || true
    echo "已尝试恢复上一版运行时。" >&2
  fi
  exit 1
fi

if [[ -n "$PREVIOUS_TARGET" && "$PREVIOUS_TARGET" != "$DEPLOY_DIR" ]]; then
  case "$PREVIOUS_TARGET" in
    "$RUNTIME_VERSIONS"/*)
      rm -rf -- "$PREVIOUS_TARGET"
      ;;
  esac
fi

echo "已安装并启动 ${LABEL}（DSH ${RUNTIME_VERSION}）"
echo "固定运行时：$DEPLOY_DIR"
echo "查看状态：bash $SCRIPT_DIR/status.sh"
echo "日志：$HOME/.dsh/dsh-web.log"
