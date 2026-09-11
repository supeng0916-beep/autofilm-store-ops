#!/usr/bin/env bash
# 崩溃自动拉起看门狗（2026-08-27，LaunchAgent 每分钟调度，由 守护安装.command 安装）。
# 保护条件（与既有启停语义零冲突）：
# - run.pid 存在 = 服务曾被启动且未主动停止 → 保护；「停止.command」会删 run.pid → 看门狗静默
# - 进程崩溃（pid 不在）→ 立即 重启.command（停残留→起服务+网关）
# - 进程假死（pid 在但健康检查连续 2 次失败，防瞬时抖动误杀）→ 重启.command
# - 后端健康但 AI 网关 18789 掉了 → 启动.command --restart（后端复用，只补网关）
set -uo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"  # ops/ 上一级即包根（同 backup.sh）
BACKEND="$PKG/app/backend"
PID_FILE="$BACKEND/run.pid"
LOG="$BACKEND/logs/watchdog.log"

# launchd 最小 PATH 找不到 node/npm：加载安装时烙下的用户 PATH（守护安装.command 生成）
# shellcheck disable=SC1091
[ -f "$PKG/ops/watchdog.env" ] && . "$PKG/ops/watchdog.env"
FAIL_FILE="$BACKEND/logs/.watchdog-health-fails"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# 未启动或已主动停止：不保护
[ -f "$PID_FILE" ] || exit 0
PID="$(cat "$PID_FILE" 2>/dev/null || true)"

if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  log "检测到后端进程已崩溃（pid=${PID:-空}，自动重启"
  bash "$PKG/重启.command" </dev/null >> "$LOG" 2>&1 || log "重启.command 退出码 $?"
  rm -f "$FAIL_FILE"
  exit 0
fi

if curl -s -o /dev/null --max-time 5 http://localhost:8000/api/v1/health; then
  rm -f "$FAIL_FILE"
  # 后端健康但网关掉了：补拉网关（启动.command 对已运行后端走复用分支，只补网关与幂等种子）
  if ! nc -z 127.0.0.1 18789 2>/dev/null; then
    log "后端健康但 AI 网关未监听，补拉网关"
    bash "$PKG/启动.command" --restart </dev/null >> "$LOG" 2>&1 || log "补拉网关退出码 $?"
  fi
  exit 0
fi

# 健康检查失败：连续 2 次才动手（防迁移/种子期间的瞬时无响应被误判）
COUNT=0
[ -f "$FAIL_FILE" ] && COUNT="$(cat "$FAIL_FILE" 2>/dev/null || echo 0)"
COUNT=$((COUNT + 1))
echo "$COUNT" > "$FAIL_FILE"
if [ "$COUNT" -ge 2 ]; then
  log "健康检查连续 ${COUNT} 次失败（进程假死），自动重启"
  rm -f "$FAIL_FILE"
  bash "$PKG/重启.command" </dev/null >> "$LOG" 2>&1 || log "重启.command 退出码 $?"
fi
