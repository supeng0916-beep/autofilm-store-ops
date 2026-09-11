#!/usr/bin/env bash
# 双击停止后台服务与 AI 网关
set -euo pipefail
cd "$(dirname "$0")/app/backend" || exit 1
if [ -f run.pid ] && kill -0 "$(cat run.pid)" 2>/dev/null; then
  PID="$(cat run.pid)"
  kill "$PID"
  rm -f run.pid
  echo "✅ 已停止服务（PID ${PID}）"
else
  echo "服务未在运行"
fi

# 同步停止 AI 网关（启动.command 拉起的 OpenClaw 进程；pid 丢失但 18789 仍在时兜底）
if [ -f gateway.pid ] && kill -0 "$(cat gateway.pid)" 2>/dev/null; then
  GW_PID="$(cat gateway.pid)"
  kill "$GW_PID" 2>/dev/null || true
  rm -f gateway.pid
  echo "✅ 已停止 AI 网关（PID ${GW_PID}）"
elif nc -z 127.0.0.1 18789 2>/dev/null && command -v openclaw >/dev/null 2>&1; then
  openclaw gateway stop >/dev/null 2>&1 || true
  echo "✅ 已停止 AI 网关（openclaw gateway stop）"
else
  echo "AI 网关未在运行"
fi
read -r -p "按回车关闭本窗口"
