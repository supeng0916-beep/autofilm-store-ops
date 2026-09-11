#!/usr/bin/env bash
# 双击启动：环境检查 → 首次生成 .env → 数据库就绪 → 迁移 → 账号种子 → AI 网关（装有 OpenClaw 时）→ 启动 → 打开浏览器
# --restart 模式（重启.command 调用）：不开浏览器、结尾不等待回车，供系统页「重启服务」按钮链路使用
set -euo pipefail
cd "$(dirname "$0")/app/backend" || exit 1
RESTART_MODE="${1:-}"

echo "== AutoFilm Demo 经营协同系统 启动 =="

# 1) 前置检查：Node ≥22
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 Node.js——双击同目录「环境安装.command」可自动装好（需联网），装完重新双击本文件"
  read -r -p "按回车关闭"; exit 1
fi
# 2) 前置检查：psql（PostgreSQL）
if ! command -v psql >/dev/null 2>&1; then
  echo "[错误] 未找到 psql——双击同目录「环境安装.command」可自动装好数据库（需联网），装完重新双击本文件"
  read -r -p "按回车关闭"; exit 1
fi

# 3) 首次运行生成 .env（随机 JWT 密钥；数据库默认本地 autofilm/autofilm/autofilm_prod）
BACKEND_DIR="$(pwd)"
PKG_ROOT="$(cd ../.. && pwd)"
# 知识源目录（包内固定相对路径 app/门店知识源）与 AI 网关凭证（与包内 openclaw/config/.env 同值）
KS_ROOT="$(cd ../门店知识源/.. 2>/dev/null && pwd || true)"  # 指向门店知识源的父目录（WG_KNOWLEDGE_SOURCE_ROOT 语义，2026-08-27 Q3）
GW_TOKEN="$(grep '^WG_OPENCLAW_GATEWAY_TOKEN=' ../../openclaw/config/.env 2>/dev/null | cut -d= -f2- || true)"
AI_KEY="$(grep '^WG_OPENCLAW_PRIMARY_KEY=' ../../openclaw/config/.env 2>/dev/null | cut -d= -f2- || true)"
if [ ! -f .env ]; then
  JWT_SECRET="$(openssl rand -hex 32)"
  SEED_PW="$(openssl rand -hex 8)"
  cat > .env <<EOF
NODE_ENV=prod
WG_PORT=8000
WG_DATABASE_URL=postgresql://autofilm:autofilm@localhost:5432/autofilm_prod
WG_JWT_SECRET=${JWT_SECRET}
WG_DEBUG=false
WG_SEED_PASSWORD=${SEED_PW}
WG_UPLOAD_DIR=uploads
# 素材待入库文件夹：门店把素材丢进该目录即自动入库（5 分钟轮询）。
# 注意：不得指向 uploads/assets 等系统存储目录（会与入库产物互相扫描）
WG_IMPORT_WATCH_DIR=uploads/inbox
WG_STATIC_DIR=../frontend
# —— AI 限额（2026-08-20 v1.5 注意事项反转：测试期保留限额 ¥100/日，¥60 提醒/¥80 重点提醒/¥100 硬上限）——
WG_AI_DAILY_BUDGET_FEN=10000
WG_AI_TASK_MAX_TOKENS=20000
# 系统页「重启服务」按钮脚本（boss 专用；相对路径按 app/backend 为 cwd 解析，包内固定位置兜底）
WG_RESTART_SCRIPT=../../重启.command
EOF
  # 知识源目录（包内固定位置 app/门店知识源，助手「查看原始文件」读取）
  if [ -n "$KS_ROOT" ]; then
    echo "WG_KNOWLEDGE_SOURCE_ROOT=${KS_ROOT}" >> .env
  fi
  # AI 网关（随包 openclaw/，token 与网关侧 openclaw/config/.env 同值）
  if [ -n "$GW_TOKEN" ]; then
    printf 'WG_OPENCLAW_GATEWAY_WS_URL=ws://127.0.0.1:18789\nWG_OPENCLAW_GATEWAY_TOKEN=%s\n' "$GW_TOKEN" >> .env
  fi
  # 知识库语义检索（MiniMax embedding，与主模型共用同一 key）
  if [ -n "$AI_KEY" ]; then
    printf 'WG_EMBEDDING_API_URL=https://api.minimaxi.com/v1/embeddings\nWG_EMBEDDING_API_KEY=%s\n' "$AI_KEY" >> .env
  fi
  echo "[首次] 已生成 backend/.env"
  echo "       数据库默认连接：autofilm/autofilm@localhost:5432/autofilm_prod"
  echo "       如本机 PostgreSQL 口令不同，请编辑 app/backend/.env 的 WG_DATABASE_URL 后重新双击"
fi

mkdir -p logs uploads
# 日志轮转（2026-08-27 运维批次）：超 50MB 切档保留 3 份，防长年运行磁盘被日志吃满
rotate_log() {
  local f="$1"
  if [ -f "$f" ]; then
    local size
    size="$(wc -c < "$f" | tr -d ' ')"
    if [ "$size" -gt 52428800 ]; then
      rm -f "$f.3"
      [ -f "$f.2" ] && mv "$f.2" "$f.3"
      [ -f "$f.1" ] && mv "$f.1" "$f.2"
      mv "$f" "$f.1"
      echo "   [日志] $f 已超过 50MB，切档保留 3 份"
    fi
  fi
}
rotate_log logs/run.log
rotate_log logs/openclaw-gateway.log
# watch 目录按 .env 实际值创建（首次生成的默认值为 uploads/inbox；留空=关闭扫描则跳过）
WATCH_DIR="$(grep '^WG_IMPORT_WATCH_DIR=' .env | cut -d= -f2- || true)"
if [ -n "$WATCH_DIR" ]; then
  mkdir -p "$WATCH_DIR"
fi

# WG_MCP_TOKEN 增量补齐（2026-09-07 阶段二 MCP 深查工具）：
# 源头在 openclaw/config/.env（网关启动 source 它，模型深查工具凭此连后端 /api/v1/mcp）；
# 缺失或占位时随机生成写回；backend/.env 缺该变量时同值追加——两处必须同值，缺一深查工具静默消失
OC_ENV_FILE="$PKG_ROOT/openclaw/config/.env"
MCP_TOKEN="$(grep '^WG_MCP_TOKEN=' "$OC_ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
if [ -z "$MCP_TOKEN" ] || [ "$MCP_TOKEN" = "change-me" ]; then
  MCP_TOKEN="$(openssl rand -hex 16)"
  if [ -f "$OC_ENV_FILE" ] && grep -q '^WG_MCP_TOKEN=' "$OC_ENV_FILE"; then
    sed -i '' "s|^WG_MCP_TOKEN=.*|WG_MCP_TOKEN=${MCP_TOKEN}|" "$OC_ENV_FILE"
  else
    printf 'WG_MCP_TOKEN=%s\n' "$MCP_TOKEN" >> "$OC_ENV_FILE"
  fi
  echo "[维护] 已生成 WG_MCP_TOKEN（MCP 深查工具令牌）写入 openclaw/config/.env"
  if nc -z 127.0.0.1 18789 2>/dev/null; then
    echo "       注意：AI 网关正在运行，需双击 重启.command 后深查工具才带上新令牌"
  fi
fi
if ! grep -q '^WG_MCP_TOKEN=' .env; then
  printf 'WG_MCP_TOKEN=%s\n' "$MCP_TOKEN" >> .env
  echo "[维护] backend/.env 已补 WG_MCP_TOKEN（与网关同值）"
fi

# 4) 数据库不存在则创建（失败不中断，交由迁移给出明确错误）
DB_URL="$(grep '^WG_DATABASE_URL=' .env | cut -d= -f2-)"
DB_NAME="$(echo "$DB_URL" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')"
DB_USER="$(echo "$DB_URL" | sed -E 's#.*//([^:/?]+).*#\1#')"
if ! psql -U "$DB_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  psql -U "$DB_USER" -d postgres -c "CREATE DATABASE \"${DB_NAME}\";" || true
fi

# 5) 迁移 + 种子（幂等，可重复执行）
echo "== 应用数据库迁移 =="
if ! npx prisma migrate deploy; then
  echo "[错误] 迁移失败——请确认 PostgreSQL/pgvector 已按 README-部署.md 安装，数据库已创建"
  read -r -p "按回车关闭"; exit 1
fi
# migrate deploy 不重新生成客户端（2026-09-02 R5 坑：升级包带了新 schema，dist 仍持旧 client，
# 运行时报 Unknown argument/undefined create）——generate 幂等，每次启动补跑一次
if ! npx prisma generate >/dev/null 2>&1; then
  echo "[警告] prisma generate 失败——若刚升级过版本且启动后报字段相关错误，请手动执行 npx prisma generate"
fi
echo "== 初始化账号 =="
npm run seed >/dev/null 2>&1 || npm run seed
if [ -f scripts/.accounts.local.json ]; then
  npm run seed:accounts
else
  echo "（未携带真人账号口令文件——占位账号可用，真人账号稍后配置）"
fi

# 6) AI 网关（OpenClaw，随包配置）：已装 CLI 则拉起并等 18789 就绪；未装则降级（业务不受影响）
AI_STATUS="off"
if command -v openclaw >/dev/null 2>&1; then
  if nc -z 127.0.0.1 18789 2>/dev/null; then
    echo "== AI 网关已就绪（18789 已监听，复用现有进程）=="
    AI_STATUS="ready"
  elif [ -f gateway.pid ] && kill -0 "$(cat gateway.pid)" 2>/dev/null; then
    echo "== AI 网关已在运行（PID $(cat gateway.pid)），等待就绪 =="
    AI_STATUS="wait"
  else
    echo "== 启动 AI 网关（OpenClaw，日志 logs/openclaw-gateway.log）=="
    cd "$PKG_ROOT"
    set -a; . ./openclaw/config/.env; set +a
    OPENCLAW_CONFIG_PATH="$PKG_ROOT/openclaw/config/openclaw.json" \
      nohup openclaw gateway run >> "$BACKEND_DIR/logs/openclaw-gateway.log" 2>&1 &
    echo $! > "$BACKEND_DIR/gateway.pid"
    # 防空闲睡眠（2026-08-26 试用反馈：门店机睡眠挂断服务）：网关存活期间阻止系统闲置休眠；
    # 合盖/手动睡眠不受 caffeinate 保护（需系统设置关闭），README-部署.md 有说明
    if command -v caffeinate >/dev/null 2>&1; then
      nohup caffeinate -is -w "$(cat "$BACKEND_DIR/gateway.pid")" >/dev/null 2>&1 &
    fi
    cd "$BACKEND_DIR"
    AI_STATUS="wait"
  fi
  if [ "$AI_STATUS" = "wait" ]; then
    AI_STATUS="timeout"
    for _ in $(seq 1 30); do
      sleep 1
      if nc -z 127.0.0.1 18789 2>/dev/null; then AI_STATUS="ready"; break; fi
    done
  fi
  if [ "$AI_STATUS" = "ready" ]; then
    echo "   ✅ AI 网关就绪（127.0.0.1:18789）"
  else
    echo "   [警告] AI 网关 30 秒内未就绪——AI 功能暂不可用，业务功能正常（排查见 logs/openclaw-gateway.log）"
  fi
else
  echo "⚠️  未检测到 OpenClaw CLI——AI 功能不可用（业务功能正常）。"
  echo "   启用方法：门店电脑安装 OpenClaw 稳定版后重新双击「启动.command」即可，配置与密钥已随包就绪"
fi

# 7) 启动后端（已运行则复用；知识源路径每次按包实际位置刷新，包整体移动后依然生效）
if [ -n "$KS_ROOT" ]; then
  export WG_KNOWLEDGE_SOURCE_ROOT="$KS_ROOT"
fi
if [ -f run.pid ] && kill -0 "$(cat run.pid)" 2>/dev/null; then
  echo "服务已在运行（PID $(cat run.pid)）"
else
  nohup node dist/main.js > logs/run.log 2>&1 &
  echo $! > run.pid
  # 防空闲睡眠（同网关：进程存活期间阻止系统闲置休眠；PID 文件仍记 node 真实进程，停止.command 不受影响）
  if command -v caffeinate >/dev/null 2>&1; then
    nohup caffeinate -is -w "$(cat run.pid)" >/dev/null 2>&1 &
  fi
  echo "== 服务启动中（日志 logs/run.log）=="
fi

# 8) 等健康检查通过后打开浏览器
#    成功条件 = health 200 且本脚本拉起的进程仍存活（防端口被其他程序占用时误报成功）
for _ in $(seq 1 30); do
  sleep 1
  if ! kill -0 "$(cat run.pid 2>/dev/null)" 2>/dev/null; then break; fi
  if curl -s -o /dev/null http://localhost:8000/api/v1/health; then break; fi
done
if curl -s -o /dev/null http://localhost:8000/api/v1/health && \
   [ -f run.pid ] && kill -0 "$(cat run.pid)" 2>/dev/null; then
  # 作品集不随包分发知识与报价图；由页面手工录入虚构资料。
  echo "   ℹ 作品集知识库与素材库为空，请通过页面录入虚构演示资料。"
  if [ "$RESTART_MODE" != "--restart" ]; then
    open "http://localhost:8000"
  fi
  echo ""
  echo "✅ 已启动：http://localhost:8000（本窗口可关闭，服务后台运行）"
  echo "   停止：双击「停止.command」；日志：app/backend/logs/run.log"
  if [ "$AI_STATUS" = "ready" ]; then
    echo "   AI：已启用（网关 127.0.0.1:18789）"
  else
    echo "   AI：未启用（业务功能正常；装 OpenClaw 后重新双击启动即可启用）"
  fi
else
  echo "[错误] 服务未就绪——请查看 logs/run.log 排查（若提示 EADDRINUSE，说明 8000 端口被其他程序占用）"
fi
if [ "$RESTART_MODE" != "--restart" ]; then
  read -r -p "按回车关闭本窗口"
fi
