#!/usr/bin/env bash
# 测试库一键重置（待办「测试库重置机制」）：drop + recreate + 迁移。
# 连接串口径与 backend/test/test-env.ts 一致：WG_TEST_DATABASE_URL 可覆盖，默认本地 autofilm_test。
set -euo pipefail
cd "$(dirname "$0")/.."

TEST_DB_URL="${WG_TEST_DATABASE_URL:-postgresql://autofilm:autofilm@localhost:5432/autofilm_test}"
DB_NAME="$(basename "${TEST_DB_URL%%\?*}")"

# 口径统一：从连接串解析主机/端口/用户/口令并 export 给 dropdb/createdb，
# 防止 WG_TEST_DATABASE_URL 指向异机时，护栏校验远端库名而 drop/create 却落本机默认服务器。
# 形态与 backend/test/test-env.ts 一致：postgresql://用户:口令@主机:端口/库名
# 只用参数展开（兼容 macOS 自带 bash 3.2），解析失败直接报错退出，绝不静默回落本机默认。
_URL_BODY="${TEST_DB_URL#*://}"
case "$_URL_BODY" in
  *@*) ;;
  *) echo "❌ 连接串解析失败：「${TEST_DB_URL}」缺少 @（期望 用户:口令@主机:端口），拒绝执行" >&2; exit 1 ;;
esac
_CREDS="${_URL_BODY%%@*}"
_HOSTPATH="${_URL_BODY#*@}"
_HOSTPORT="${_HOSTPATH%%/*}"
case "$_CREDS" in
  *:*) ;;
  *) echo "❌ 连接串解析失败：「@」前缺少 用户:口令 分隔，拒绝执行" >&2; exit 1 ;;
esac
case "$_HOSTPORT" in
  *:*) ;;
  *) echo "❌ 连接串解析失败：「@」后缺少 主机:端口 分隔，拒绝执行" >&2; exit 1 ;;
esac
export PGUSER="${_CREDS%%:*}"
export PGPASSWORD="${_CREDS#*:}"
export PGHOST="${_HOSTPORT%%:*}"
export PGPORT="${_HOSTPORT#*:}"

# 护栏：库名必须带 test 后缀，防误删生产/开发库
case "$DB_NAME" in
  *test*) ;;
  *) echo "❌ 拒绝重置：库名「${DB_NAME}」不含 test，疑似非测试库" >&2; exit 1 ;;
esac

echo "→ 删除并重建测试库 $DB_NAME"
dropdb --if-exists -- "$DB_NAME"
createdb -- "$DB_NAME"

echo "→ 应用全部迁移"
(cd backend && WG_DATABASE_URL="$TEST_DB_URL" npx prisma migrate deploy)

echo "✅ 测试库已重置（种子数据清零；按需 npm run seed 重建基础种子）"
