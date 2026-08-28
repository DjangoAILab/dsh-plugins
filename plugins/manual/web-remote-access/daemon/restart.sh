#!/usr/bin/env bash
# 安全重启 DSH web 守护：由 launchd 负责杀旧拉新（不是自 kill，可放心在任意 shell 运行）。
set -euo pipefail

LABEL="org.example.dsh-web"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# bundle 只在冷启动时加载。先验证 profile 组合和每个树外 bundle 的入口；失败时保留当前进程。
bash "$SCRIPT_DIR/preflight.sh"

launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "已触发 $LABEL 重启（launchd 会拉起新实例）"
