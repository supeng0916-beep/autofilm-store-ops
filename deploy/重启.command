#!/usr/bin/env bash
# 双击重启（或由系统页「重启服务」按钮触发）：停止服务与网关 → 等端口释放 → 以 --restart 模式启动。
# --restart 模式下 启动.command 不开浏览器、结尾不等待回车（页面会自动轮询健康检查后刷新）。
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "== AutoFilm Demo 经营协同系统 重启 =="

# 缓冲 2 秒：由后端按钮触发时，先让 202 响应送达浏览器再停服务
sleep 2

# —— 停止（与 停止.command 同逻辑，内联执行避免其结尾交互） ——
cd "$DIR/app/backend" || exit 1
if [ -f run.pid ] && kill -0 "$(cat run.pid)" 2>/dev/null; then
  PID="$(cat run.pid)"
  kill "$PID"
  rm -f run.pid
  echo "✅ 已停止服务（PID ${PID}）"
else
  echo "服务未在运行"
fi
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

# 等服务端口释放（最长 15 秒），避免重启分支误判「已在运行」
for _ in $(seq 1 15); do
  if ! nc -z 127.0.0.1 8000 2>/dev/null; then break; fi
  sleep 1
done

# —— 启动（--restart：跳过开浏览器与结尾交互） ——
bash "$DIR/启动.command" --restart

read -r -p "按回车关闭本窗口"
