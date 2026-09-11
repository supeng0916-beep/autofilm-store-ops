#!/usr/bin/env bash
# S04/SEC03 密钥扫描（P6-04）：git 跟踪文件密钥模式扫描 + .env 不入库断言。
# 纳入 scripts/ci.sh；零依赖（git grep + grep）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0

echo "== 密钥扫描：.env 不入库 =="
for f in backend/.env openclaw/config/.env frontend/.env deploy/.env; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    echo "❌ $f 已被 git 跟踪（S04 违规）"
    fail=1
  fi
done
[ "$fail" -eq 0 ] && echo "✅ 无 .env 被跟踪"

echo "== 密钥扫描：跟踪文件密钥赋值模式 =="
# 密钥型键名后接 ≥20 位高熵值（排除显式占位值与本地开发默认口令）
pattern='(api[_-]?key|apikey|client[_-]?secret|access[_-]?token|secret[_-]?key|primary[_-]?key|passwd|password)["'"'"']?\s*[:=]\s*["'"'"']?[A-Za-z0-9+/_-]{20,}'
allowlist='change-?me|test-only|example|placeholder|your[-_]|fake|REPLACE_|dev-only|autofilm:autofilm@localhost|dGhpcy1pcy1ub3Q'
matches="$(git grep -nEi "$pattern" -- \
  ':!package-lock.json' ':!backend/package-lock.json' ':!frontend/package-lock.json' \
  ':!frontend/src/api/generated/**' \
  | grep -viE "$allowlist" || true)"
if [ -n "$matches" ]; then
  echo "❌ 疑似密钥入库："
  echo "$matches"
  fail=1
else
  echo "✅ 无密钥赋值模式命中"
fi

echo "== 密钥扫描：私钥块 =="
if git grep -lE 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' -- ':!*.md' >/dev/null 2>&1; then
  echo "❌ 检出私钥块"
  git grep -lE 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' -- ':!*.md'
  fail=1
else
  echo "✅ 无私钥块"
fi

if [ "$fail" -ne 0 ]; then
  echo "❌ 密钥扫描未通过"
  exit 1
fi
echo "✅ 密钥扫描通过"
