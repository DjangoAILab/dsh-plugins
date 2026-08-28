#!/usr/bin/env bash
# 卸载 DSH web 的 launchd 守护（不删除日志与 profile 补丁）。
set -euo pipefail

LABEL="org.example.dsh-web"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST_DST"
echo "已卸载 $LABEL"
