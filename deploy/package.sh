#!/usr/bin/env bash
# 一键打包：构建前后端并组装自包含发布目录 dist-release/autofilm-store-ops/
# 产物拷到门店电脑后，双击「启动.command」即完成迁移→账号→启动→打开浏览器
# 前置（打包机）：Node ≥22、两工程依赖已安装（npm install）
# 产物体积说明：backend/node_modules 为全量依赖（含 prisma CLI/tsx），目标机离线可完成迁移与种子
#
# 升级包模式（2026-08-27 运维批次）：bash deploy/package.sh --upgrade
#   产出 dist-release-upgrade/autofilm-store-ops-升级包-<时间戳>/（仅数 MB：新前后端产物+迁移+技能+升级.command）。
#   客户把整个升级文件夹放到 autofilm-store-ops 同一层（或包内），双击「升级.command」即可：
#   自动先备份数据库→停服→备份旧产物→替换→启动自动迁移→健康检查，失败自动回滚。
#   绝不触碰 .env / uploads / 数据库数据。注意：新增了 npm 依赖的版本必须发全量包（升级包不含 node_modules）。
#
# 网盘交付模式（2026-08-28）：bash deploy/package.sh --netdisk
#   产出独立目录 dist-release-netdisk/autofilm-store-ops/（绝不碰正在运行的 dist-release/）：
#   不含客户照片/备份/日志（本就不随包），且 openclaw/config/.env 只带占位密钥（不带走真实密钥），
#   附「换密钥.command」+「密钥替换说明.md」。交付流程见 README-部署.md「网盘交付」。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="full"
if [ "${1:-}" = "--netdisk" ]; then MODE="netdisk"; fi
RELEASE="$ROOT/dist-release/autofilm-store-ops"
if [ "$MODE" = "netdisk" ]; then RELEASE="$ROOT/dist-release-netdisk/autofilm-store-ops"; fi

if [ "${1:-}" = "--upgrade" ]; then
  STAMP="$(date +%Y%m%d-%H%M)"
  UP="$ROOT/dist-release-upgrade/autofilm-store-ops-升级包-$STAMP"
  rm -rf "$ROOT/dist-release-upgrade"
  mkdir -p "$UP/app/backend" "$UP/app/frontend" "$UP/openclaw"
  echo "== 升级包：构建前端 =="
  (cd "$ROOT/frontend" && npm run build)
  cp -R "$ROOT/frontend/dist/." "$UP/app/frontend/"
  echo "== 升级包：构建后端 =="
  (cd "$ROOT/backend" && npm run build)
  cp -R "$ROOT/backend/dist" "$UP/app/backend/dist"
  cp -R "$ROOT/backend/prisma" "$UP/app/backend/prisma"
  echo "== 升级包：AI 技能 =="
  cp -R "$ROOT/openclaw/skills" "$UP/openclaw/skills"
  cp "$ROOT/deploy/升级.command" "$UP/升级.command"
  chmod +x "$UP/升级.command"
  SIZE="$(du -sh "$UP" | cut -f1)"
  echo ""
  echo "✅ 升级包完成：${UP}（${SIZE}）"
  echo "   发给客户整个文件夹；客户把它放到 autofilm-store-ops 同一层（或包内），双击「升级.command」"
  echo "   自动：备份数据库 → 替换产物 → 迁移 → 健康检查，失败自动回滚（不碰 .env/uploads/数据）"
  exit 0
fi

echo "== 清理并建目录 =="
# 护栏（2026-08-28）：full 模式会清空输出目录；若该目录正是运行中的门店实例（含客户照片/备份/.env），必须先停服
if [ -f "$RELEASE/app/backend/run.pid" ] && kill -0 "$(cat "$RELEASE/app/backend/run.pid")" 2>/dev/null; then
  echo "❌ $RELEASE 正在运行（内含门店客户数据），禁止覆盖。"
  echo "   先双击「停止.command」再打包；或改用 bash deploy/package.sh --netdisk 输出独立清洁包。"
  exit 1
fi
rm -rf "$RELEASE"
mkdir -p "$RELEASE/app/backend" "$RELEASE/app/frontend"

echo "== 构建前端（Vite 产物）=="
(cd "$ROOT/frontend" && npm run build)
cp -R "$ROOT/frontend/dist/." "$RELEASE/app/frontend/"

echo "== 构建后端（Nest dist）=="
(cd "$ROOT/backend" && npm run build)
cp -R "$ROOT/backend/dist" "$RELEASE/app/backend/dist"

echo "== 组装后端运行件（全量 node_modules + 迁移 + 配置 + 脚本）=="
cp -R "$ROOT/backend/node_modules" "$RELEASE/app/backend/node_modules"
# 剔除开发/测试缓存，避免随包分发（不影响 prisma CLI/tsx 等运行件）
rm -rf "$RELEASE/app/backend/node_modules/.cache" \
       "$RELEASE/app/backend/node_modules/.vite" \
       "$RELEASE/app/backend/node_modules/.vite-temp"
cp -R "$ROOT/backend/prisma" "$RELEASE/app/backend/prisma"
cp "$ROOT/backend/package.json" "$RELEASE/app/backend/package.json"
cp "$ROOT/backend/prisma.config.ts" "$RELEASE/app/backend/prisma.config.ts"
# 种子与运维脚本全量随包（seed/seed:accounts/seed:knowledge/seed:assets/check-db 等，目标机离线可重播种）
cp -R "$ROOT/backend/scripts" "$RELEASE/app/backend/scripts"
# 真人账号口令文件随包携带（gitignore 的本地文件，位于 scripts/ 内）：部署机账号口令与打包机一致
if [ -f "$RELEASE/app/backend/scripts/.accounts.local.json" ]; then
  echo "  （已携带真人账号口令文件）"
fi

echo "== AI 网关配置与技能随包（openclaw/）=="
mkdir -p "$RELEASE/openclaw/config"
cp "$ROOT/openclaw/config/openclaw.json" "$RELEASE/openclaw/config/"
cp "$ROOT/openclaw/config/.env.example" "$RELEASE/openclaw/config/"
cp -R "$ROOT/openclaw/skills" "$RELEASE/openclaw/skills"
if [ "$MODE" = "netdisk" ]; then
  # 网盘交付：真实密钥不带走——.env 落占位值，正式密钥单独渠道发送，客户双击「换密钥.command」收尾
  cp "$ROOT/openclaw/config/.env.example" "$RELEASE/openclaw/config/.env"
  cp "$ROOT/deploy/换密钥.command" "$RELEASE/换密钥.command"
  cp "$ROOT/deploy/密钥替换说明.md" "$RELEASE/密钥替换说明.md"
  chmod +x "$RELEASE/换密钥.command"
  echo "  （网盘模式：openclaw/config/.env 为占位密钥；附 换密钥.command/密钥替换说明.md）"
else
  # 物理交付：config/.env 含 MiniMax 真实密钥（安全责任见 README-部署.md「密钥安全责任」）
  cp "$ROOT/openclaw/config/.env" "$RELEASE/openclaw/config/"
  echo "  （openclaw/config/.env 含真实密钥——包即钥匙，仅限门店电脑使用）"
fi

echo "== 门店知识源随包（知识源端点数据依赖，固定相对路径 app/门店知识源）=="
cp -R "$ROOT/门店知识源" "$RELEASE/app/门店知识源"

echo "== 报价图随包（seed:assets 数据源，固定相对路径 app/报价图）=="
cp -R "$ROOT/报价图" "$RELEASE/app/报价图"

echo "== 备份/恢复/看门狗脚本随包 =="
mkdir -p "$RELEASE/ops"
cp "$ROOT/deploy/backup.sh" "$ROOT/deploy/restore.sh" "$ROOT/deploy/ops/watchdog.sh" "$RELEASE/ops/"

echo "== 启动/停止/重启/守护安装/环境安装/说明 =="
cp "$ROOT/deploy/启动.command" "$RELEASE/启动.command"
cp "$ROOT/deploy/停止.command" "$RELEASE/停止.command"
cp "$ROOT/deploy/重启.command" "$RELEASE/重启.command"
cp "$ROOT/deploy/守护安装.command" "$RELEASE/守护安装.command"
cp "$ROOT/deploy/环境安装.command" "$RELEASE/环境安装.command"
cp "$ROOT/deploy/README-部署.md" "$RELEASE/README-部署.md"
chmod +x "$RELEASE/启动.command" "$RELEASE/停止.command" "$RELEASE/重启.command" "$RELEASE/守护安装.command" "$RELEASE/环境安装.command" "$RELEASE/ops/"*.sh

echo ""
echo "✅ 打包完成：$RELEASE"
if [ "$MODE" = "netdisk" ]; then
  echo "   网盘交付流程："
  echo "   1) cd $(dirname "$RELEASE") && zip -r autofilm-store-ops-网盘交付-$(date +%Y%m%d).zip autofilm-store-ops"
  echo "   2) 上传 zip 到百度网盘，生成链接+提取码"
  echo "   3) 链接与提取码分两条渠道发（如链接走短信、提取码走电话），包内无正式密钥"
  echo "   4) 客户侧：xattr 解拦 → 环境安装.command → 启动.command → 守护安装.command"
  echo "   5) 收尾：客户双击「换密钥.command」粘贴单独渠道收到的新 APIKey → 重启.command"
else
  echo "   拷贝整个 autofilm-store-ops 文件夹到门店电脑 → 双击「环境安装.command」装环境 → 双击「启动.command」开系统"
fi
