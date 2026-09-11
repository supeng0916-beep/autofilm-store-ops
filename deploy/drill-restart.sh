#!/usr/bin/env bash
# 崩溃恢复演练（P6-03）：独立端口拉起生产构建 → kill -9 模拟崩溃 → 重启 → 健康+数据对账，逐步计时。
# 用法：bash deploy/drill-restart.sh（不占用 dev :8000；使用 dev 库只读对账）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WG_DRILL_PORT:-8010}"
export PGPASSWORD="${PGPASSWORD:-autofilm}"
PGHOST_="${PGHOST:-localhost}"; PGUSER_="${PGUSER:-autofilm}"; DB="${WG_DRILL_DB:-autofilm_dev}"
HEALTH="http://127.0.0.1:$PORT/api/v1/health"

cleanup() {
  local p
  p="$(port_pid)"
  [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true
}
trap cleanup EXIT

now_ms() { python3 -c "import time;print(int(time.time()*1000))"; }

# 实际占用端口的进程 PID（nohup 包装层 pid 与 node 监听 pid 可能不一致，按端口取才可靠）；
# lsof 无匹配时退出码非 0，须容错以免 set -e/pipefail 误杀脚本
port_pid() { (lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true) | head -1; }

launch() {
  (cd "$ROOT/backend" && WG_PORT=$PORT NODE_ENV=prod nohup node dist/main.js > /tmp/wg-drill.log 2>&1 &)
}

wait_health() {
  for _ in $(seq 1 60); do
    if curl -sf "$HEALTH" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

echo "== 构建 =="
(cd "$ROOT/backend" && npm run build --silent) 

echo "== 基线数据：打演练标记（恢复后对账）=="
MARK="drill-$(date +%s)"
psql -h "$PGHOST_" -U "$PGUSER_" -d "$DB" -qc "INSERT INTO \"SystemMeta\" (key, value, \"updatedAt\") VALUES ('drill.mark','$MARK', NOW()) ON CONFLICT (key) DO UPDATE SET value='$MARK';"

echo "== 首次启动（端口 ${PORT}）=="
T0=$(now_ms)
launch
wait_health || { echo "❌ 首次启动失败"; tail -20 /tmp/wg-drill.log; exit 1; }
PID="$(port_pid)"
T1=$(now_ms)
echo "首次启动耗时：$((T1 - T0))ms（监听进程 ${PID}）"

echo "== 模拟崩溃：kill -9 =="
kill -9 "$PID"
sleep 1
# 崩溃有效性：端口必须已释放，否则演练无效
REMAIN="$(port_pid)"
[ -z "$REMAIN" ] || { echo "❌ 崩溃模拟失败：端口仍被进程 ${REMAIN} 占用"; exit 1; }

echo "== 重启 =="
T2=$(now_ms)
launch
wait_health || { echo "❌ 重启失败"; tail -20 /tmp/wg-drill.log; exit 1; }
PID="$(port_pid)"
T3=$(now_ms)
echo "崩溃后重启 RTO：$((T3 - T2))ms（监听进程 ${PID}）"

echo "== 数据对账：演练标记存在 =="
GOT=$(psql -h "$PGHOST_" -U "$PGUSER_" -d "$DB" -tAc "SELECT value FROM \"SystemMeta\" WHERE key='drill.mark';")
[ "$GOT" = "$MARK" ] && echo "✅ 数据完好（标记 ${MARK}）" || { echo "❌ 数据对账失败"; exit 1; }

kill -9 "$PID"
echo "✅ 崩溃恢复演练通过（清理标记）"
psql -h "$PGHOST_" -U "$PGUSER_" -d "$DB" -qc "DELETE FROM \"SystemMeta\" WHERE key='drill.mark';"
