#!/usr/bin/env bash
# 统一代码门禁入口（规范 S02）：任一项失败即整体失败
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== 开发治理：规则回归 + 源码检查 =="
node --test "$ROOT/scripts/governance.test.mjs"
node "$ROOT/scripts/governance.mjs"

echo "== 后端：ESLint + Prettier =="
(cd "$ROOT/backend" && npm run lint)
echo "== 后端：类型检查 =="
(cd "$ROOT/backend" && npm run typecheck)
echo "== 后端：Vitest =="
(cd "$ROOT/backend" && npm run test)
echo "== 前端：类型检查 =="
(cd "$ROOT/frontend" && npm run typecheck)
echo "== 前端：ESLint + Prettier =="
(cd "$ROOT/frontend" && npm run lint)
echo "== 前端：Vitest =="
(cd "$ROOT/frontend" && npm run test)
echo "== 前端：构建 =="
(cd "$ROOT/frontend" && npm run build)
echo "== 密钥扫描（S04/P6-04）=="
bash "$ROOT/scripts/secret-scan.sh"
echo "✅ 全部门禁通过"
