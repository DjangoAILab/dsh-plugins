#!/usr/bin/env bash
# 查看 DSH web 守护状态与监听情况。
LABEL="org.example.dsh-web"
PORT="${DSH_WEB_PORT:-3080}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
RUNTIME_CURRENT="${DSH_HOME:-$HOME/.dsh}/runtime/current"

echo "=== launchd 状态 ==="
launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|pid|last exit" || echo "未加载"

echo
echo "=== 固定运行时 ==="
EXPECTED_VERSION="$($NODE_BIN -e 'const p = require(process.argv[1]); process.stdout.write(p.dependencies["@deepseek-ai/dsh"])' "$SCRIPT_DIR/runtime-package.json")"
INSTALLED_VERSION="$($NODE_BIN -e 'const p = require(process.argv[1]); process.stdout.write(p.version)' "$RUNTIME_CURRENT/node_modules/@deepseek-ai/dsh/package.json" 2>/dev/null || true)"
echo "期望版本：$EXPECTED_VERSION"
echo "实际版本：${INSTALLED_VERSION:-未安装}"
echo "运行时链接：$(readlink "$RUNTIME_CURRENT" 2>/dev/null || echo 未安装)"

echo
echo "=== 端口 $PORT 监听 ==="
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || echo "无监听"

echo
echo "=== HTTP 探测 ==="
HTTP_STATUS="$(curl -sS -o /dev/null --max-time 3 -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null || true)"
[[ "$HTTP_STATUS" == "200" ]] && echo "HTTP 200" || echo "不可用（${HTTP_STATUS:-无响应}）"
