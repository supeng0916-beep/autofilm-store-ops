#!/usr/bin/env bash
# 安装崩溃自动拉起（2026-08-27）：注册当前用户的 LaunchAgent，每分钟巡检本包服务。
# - 只保护「启动过后」的服务：双击「停止.command」主动停止不会被拉起；崩溃/假死 2 分钟内自动恢复
# - 重复运行安全（先卸载再重装，路径变了重跑本文件即可）
# - 卸载：双击本文件时按住…不可行——终端执行 `bash 守护安装.command --remove`，或删
#   ~/Library/LaunchAgents/com.autofilm-store-ops.watchdog.plist 后执行 launchctl unload 该文件
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.autofilm-store-ops.watchdog"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [ "${1:-}" = "--remove" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✅ 已卸载崩溃自动拉起（正在运行的服务不受影响）"
  read -r -p "按回车关闭本窗口"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$PKG/app/backend/logs"
# launchd 只给最小 PATH（找不到 node/npm）——安装时把当前 shell 的 PATH 烙进环境文件供看门狗加载
printf 'export PATH="%s"\n' "$PATH" > "$PKG/ops/watchdog.env"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${PKG}/ops/watchdog.sh</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${PKG}/app/backend/logs/watchdog-launchd.log</string>
  <key>StandardErrorPath</key><string>${PKG}/app/backend/logs/watchdog-launchd.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✅ 已安装崩溃自动拉起（每分钟巡检）："
echo "   - 服务崩溃 → 自动重启（1 分钟内发现）"
echo "   - 服务假死（健康检查连续 2 次失败）→ 自动重启（约 2 分钟内）"
echo "   - 主动双击「停止.command」不会被拉起（重启系统后需双击「启动.command」开服务）"
echo "   - 看门狗日志：app/backend/logs/watchdog.log"
read -r -p "按回车关闭本窗口"
