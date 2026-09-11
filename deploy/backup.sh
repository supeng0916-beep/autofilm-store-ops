#!/usr/bin/env bash
# 备份（P6-03，任务书 §7 可靠性）：pg_dump 自定义格式 → backups/ 时间戳文件，保留最近 N 份。
# 用法：bash deploy/backup.sh [库名]（默认 autofilm_dev；连接参数取环境变量 PG* 或默认本机）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${1:-autofilm_dev}"
RETAIN="${WG_BACKUP_RETAIN:-14}"
BACKUP_DIR="${WG_BACKUP_DIR:-$ROOT/backups}"
export PGPASSWORD="${PGPASSWORD:-autofilm}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/autofilm-${DB}-${STAMP}.dump"

START=$(date +%s)
pg_dump -h "${PGHOST:-localhost}" -U "${PGUSER:-autofilm}" -Fc -d "$DB" -f "$OUT"
END=$(date +%s)
SIZE=$(du -h "$OUT" | cut -f1)
echo "✅ 备份完成：${OUT}（${SIZE}，耗时 $((END - START))s）"

# 保留策略：仅保留最近 RETAIN 份该库备份
ls -1t "$BACKUP_DIR/autofilm-${DB}-"*.dump 2>/dev/null | tail -n +$((RETAIN + 1)) | while read -r old; do
  rm -f "$old"
  echo "清理过期备份：$old"
done
