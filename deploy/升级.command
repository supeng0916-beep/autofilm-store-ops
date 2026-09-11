#!/usr/bin/env bash
# 一键升级（2026-08-27 运维批次）：把本升级文件夹放到 autofilm-store-ops 同一层（或 autofilm-store-ops 里面），双击本文件。
# 流程：①备份数据库（失败即中止，不做任何改动）→ ②停止服务 → ③备份旧产物 → ④替换新产物
#       （绝不触碰 .env / uploads / 数据库数据）→ ⑤启动（自动执行数据库结构迁移）
#       → ⑥健康检查 90 秒：通过则清理旧产物备份；失败则自动回滚到升级前版本。
set -euo pipefail
UPG="$(cd "$(dirname "$0")" && pwd)"

# 定位现有安装：优先「升级文件夹与 autofilm-store-ops 同层」，兼容「放在 autofilm-store-ops 包内」
TARGET=""
if [ -d "$UPG/../autofilm-store-ops/app/backend" ]; then
  TARGET="$(cd "$UPG/.." && pwd)/autofilm-store-ops"
elif [ -d "$(dirname "$UPG")/app/backend" ]; then
  TARGET="$(dirname "$UPG")"
fi
if [ -z "$TARGET" ] || [ ! -d "$TARGET/app/backend" ]; then
  echo "❌ 未找到 autofilm-store-ops 文件夹。请把本升级文件夹放到 autofilm-store-ops 的同一层（推荐）或 autofilm-store-ops 里面，再重新双击。"
  read -r -p "按回车关闭本窗口"
  exit 1
fi
echo "== AutoFilm Demo 升级（目标：${TARGET}）=="

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKEND_DIR="$TARGET/app/backend"

# ① 升级前数据库备份——失败立即中止（此时未改动任何文件）
DB_NAME="$(grep '^WG_DATABASE_URL=' "$BACKEND_DIR/.env" 2>/dev/null | cut -d= -f2- | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')"
DB_NAME="${DB_NAME:-autofilm_prod}"
echo "== ① 数据库备份（库名 ${DB_NAME}，保留最近 14 份）=="
if ! bash "$TARGET/ops/backup.sh" "$DB_NAME"; then
  echo "❌ 升级前备份失败——已中止，未做任何改动。请双击「启动.command」确认系统仍可运行后联系技术支持。"
  read -r -p "按回车关闭本窗口"
  exit 1
fi

# ② 停止服务与网关（</dev/null 跳过停止脚本的结尾交互）
echo "== ② 停止服务 =="
bash "$TARGET/停止.command" </dev/null || true

# ③ 备份旧产物（升级成功后删除，失败时用于回滚）
echo "== ③ 备份当前产物 =="
mv "$BACKEND_DIR/dist" "$BACKEND_DIR/dist.bak-$STAMP"
mv "$TARGET/app/frontend" "$TARGET/app/frontend.bak-$STAMP"
SKILLS_REPLACED=0
if [ -d "$TARGET/openclaw/skills" ] && [ -d "$UPG/openclaw/skills" ]; then
  mv "$TARGET/openclaw/skills" "$TARGET/openclaw/skills.bak-$STAMP"
  SKILLS_REPLACED=1
fi

# ④ 替换新产物（.env / uploads / logs / 数据库一概不动）
echo "== ④ 替换新产物 =="
cp -R "$UPG/app/backend/dist" "$BACKEND_DIR/dist"
cp -R "$UPG/app/frontend" "$TARGET/app/frontend"
if [ "$SKILLS_REPLACED" = "1" ]; then
  cp -R "$UPG/openclaw/skills" "$TARGET/openclaw/skills"
fi
# 数据库迁移文件增量合入（prisma migrate deploy 在启动时自动执行未跑过的迁移）
cp -R "$UPG/app/backend/prisma/." "$BACKEND_DIR/prisma/"

# ⑤ 启动（--restart：不开浏览器不交互）
echo "== ⑤ 启动并自动迁移数据库结构 =="
bash "$TARGET/启动.command" --restart </dev/null

# ⑥ 健康检查（90 秒；条件=health 200 且新进程存活，与启动.command 同口径）
echo "== ⑥ 健康检查 =="
OK=0
for _ in $(seq 1 45); do
  sleep 2
  if curl -s -o /dev/null http://localhost:8000/api/v1/health && \
     [ -f "$BACKEND_DIR/run.pid" ] && kill -0 "$(cat "$BACKEND_DIR/run.pid")" 2>/dev/null; then
    OK=1
    break
  fi
done

if [ "$OK" = "1" ]; then
  rm -rf "$BACKEND_DIR/dist.bak-$STAMP" "$TARGET/app/frontend.bak-$STAMP"
  [ "$SKILLS_REPLACED" = "1" ] && rm -rf "$TARGET/openclaw/skills.bak-$STAMP"
  echo ""
  echo "✅ 升级完成（数据库备份保留在包根 backups/）。请打开 http://localhost:8000 抽查常用功能。"
else
  echo "❌ 升级后健康检查未通过——正在自动回滚到升级前版本…"
  bash "$TARGET/停止.command" </dev/null || true
  rm -rf "$BACKEND_DIR/dist" "$TARGET/app/frontend"
  mv "$BACKEND_DIR/dist.bak-$STAMP" "$BACKEND_DIR/dist"
  mv "$TARGET/app/frontend.bak-$STAMP" "$TARGET/app/frontend"
  if [ "$SKILLS_REPLACED" = "1" ]; then
    rm -rf "$TARGET/openclaw/skills"
    mv "$TARGET/openclaw/skills.bak-$STAMP" "$TARGET/openclaw/skills"
  fi
  bash "$TARGET/启动.command" --restart </dev/null || true
  echo "已回滚。若仍打不开，请把「系统运维 → 导出诊断包」的文件发给技术支持（升级前数据库备份在 backups/）。"
fi
read -r -p "按回车关闭本窗口"
