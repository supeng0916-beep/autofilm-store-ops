#!/usr/bin/env bash
# OpenClaw 环境检查（P2-06）：版本基线 + 配置齐备性。退出码 0=就绪。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== Node 版本（要求 ≥22） =="
node --version

echo "== OpenClaw 安装状态 =="
if command -v openclaw >/dev/null 2>&1; then
  VERSION="$(openclaw --version || true)"
  echo "已安装：${VERSION}"
  echo "提示：请把该版本号记录到 openclaw/README.md 的『基线版本』节（任务书要求稳定版本基线）"
else
  echo "未安装 OpenClaw —— 按 docs/dev-setup.md『OpenClaw 接入 runbook』安装稳定版"
fi

echo "== 仓库侧工件 =="
for f in openclaw/config/openclaw.json openclaw/config/.env.example openclaw/skills/hello/index.ts; do
  [ -f "$ROOT/$f" ] && echo "✅ $f" || { echo "❌ 缺少 $f"; exit 1; }
done

echo "== 本地凭证文件（只查存在性，不读内容） =="
if [ -f "$ROOT/openclaw/config/.env" ]; then
  echo "✅ openclaw/config/.env 存在"
else
  echo "⚠️ openclaw/config/.env 不存在 —— 复制 .env.example 后本机填入真实值（勿入对话/提交）"
fi
if [ -f "$ROOT/backend/.env" ] && grep -q "WG_OPENCLAW_GATEWAY_URL" "$ROOT/backend/.env"; then
  echo "✅ backend/.env 已含 OpenClaw 配置键"
else
  echo "⚠️ backend/.env 缺少 OpenClaw 配置键（对照 backend/.env.example 补齐）"
fi
echo "== 检查完成 =="
