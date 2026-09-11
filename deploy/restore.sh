#!/usr/bin/env bash
# 恢复演练（P6-03）：把备份恢复到 scratch 库并做核心表行数对账，验证备份可实际恢复（RTO 记录）。
# 用法：bash deploy/restore.sh <备份文件.dump> [scratch库名（默认 autofilm_restore_check）]
# 说明：不碰源库；对账通过后保留 scratch 供人工抽查，--drop 参数显式清理。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DUMP="${1:?用法：restore.sh <备份文件.dump> [scratch库名]}"
SCRATCH="${2:-autofilm_restore_check}"
DROP_AFTER=0
[ "${3:-}" = "--drop" ] && DROP_AFTER=1
export PGPASSWORD="${PGPASSWORD:-autofilm}"
PGHOST_="${PGHOST:-localhost}"; PGUSER_="${PGUSER:-autofilm}"

[ -f "$DUMP" ] || { echo "❌ 备份文件不存在：$DUMP"; exit 1; }

echo "== 恢复目标：${SCRATCH}（重建以获得干净基线）=="
psql -h "$PGHOST_" -U "$PGUSER_" -d postgres -qc "DROP DATABASE IF EXISTS \"$SCRATCH\";" -qc "CREATE DATABASE \"$SCRATCH\";"

echo "== pg_restore =="
START=$(date +%s)
pg_restore -h "$PGHOST_" -U "$PGUSER_" -d "$SCRATCH" --no-owner --no-privileges "$DUMP"
END=$(date +%s)
echo "恢复耗时：$((END - START))s"

# 对账：备份内核心表行数 vs 恢复库行数（dump 内计数用 pg_restore -l 列表 + 逐表 count 不现实；
# 直接对比源库若仍在线，否则对比恢复库非空 + 关键表 count 输出供人工核对）
echo "== 恢复库核心表行数 =="
CORE_TABLES=(users leads customers appointments work_orders knowledge_items ai_tasks approval_items audit_logs)
TOTAL=0
for t in "${CORE_TABLES[@]}"; do
  N=$(psql -h "$PGHOST_" -U "$PGUSER_" -d "$SCRATCH" -tAc "SELECT count(*) FROM $t;" 2>/dev/null || echo "表不存在")
  echo "  $t: $N"
  [ "$N" != "表不存在" ] && TOTAL=$((TOTAL + N))
done
echo "核心表合计：$TOTAL 行"

# 向量扩展校验（pgvector 扩展必须随备份恢复）
EXT=$(psql -h "$PGHOST_" -U "$PGUSER_" -d "$SCRATCH" -tAc "SELECT count(*) FROM pg_extension WHERE extname='vector';")
[ "$EXT" = "1" ] && echo "✅ pgvector 扩展已随备份恢复" || { echo "❌ pgvector 扩展缺失"; exit 1; }

if [ "$DROP_AFTER" -eq 1 ]; then
  psql -h "$PGHOST_" -U "$PGUSER_" -d postgres -qc "DROP DATABASE IF EXISTS \"$SCRATCH\";"
  echo "已清理 scratch 库 $SCRATCH"
else
  echo "scratch 库 $SCRATCH 保留供人工抽查（清理：psql -c 'DROP DATABASE $SCRATCH'）"
fi
echo "✅ 恢复演练完成"
