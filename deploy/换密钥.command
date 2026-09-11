#!/usr/bin/env bash
# 双击换密钥：把技术支持单独渠道（短信/电话）给到的新 MiniMax APIKey 同步写入
# openclaw/config/.env 与 app/backend/.env（网关 token 一并轮换，两处自动同值），
# 写完提示双击「重启.command」生效。避免手改两文件漏改/改错。
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
OC_ENV="$DIR/openclaw/config/.env"
BE_ENV="$DIR/app/backend/.env"

echo "== AutoFilm Demo · 更换 AI 密钥 =="
[ -f "$OC_ENV" ] || { echo "❌ 找不到 openclaw/config/.env，请把本文件放在 autofilm-store-ops 文件夹里再双击"; exit 1; }

read -rsp "粘贴新 APIKey（输入不显示，回车确认）：" NEW_KEY
echo ""
NEW_KEY="$(echo "$NEW_KEY" | tr -d '[:space:]')"
if [ "${#NEW_KEY}" -lt 8 ] || [[ "$NEW_KEY" == *"|"* ]]; then
  echo "❌ 密钥不合法（太短或含 | 字符），未做任何修改"; exit 1;
fi

# 网关访问 token 一并轮换（后端镜像同值，防旧包 token 泄露后被蹭网关）；
# MCP 深查工具令牌一并轮换（2026-09-07 阶段二，同样两处同值）
NEW_GW="$(openssl rand -hex 24)"
NEW_MCP="$(openssl rand -hex 16)"

sed -i '' "s|^WG_OPENCLAW_PRIMARY_KEY=.*|WG_OPENCLAW_PRIMARY_KEY=${NEW_KEY}|" "$OC_ENV"
sed -i '' "s|^WG_OPENCLAW_GATEWAY_TOKEN=.*|WG_OPENCLAW_GATEWAY_TOKEN=${NEW_GW}|" "$OC_ENV"
if grep -q '^WG_MCP_TOKEN=' "$OC_ENV"; then
  sed -i '' "s|^WG_MCP_TOKEN=.*|WG_MCP_TOKEN=${NEW_MCP}|" "$OC_ENV"
else
  printf 'WG_MCP_TOKEN=%s\n' "$NEW_MCP" >> "$OC_ENV"
fi

if [ -f "$BE_ENV" ]; then
  sed -i '' "s|^WG_OPENCLAW_GATEWAY_TOKEN=.*|WG_OPENCLAW_GATEWAY_TOKEN=${NEW_GW}|" "$BE_ENV"
  sed -i '' "s|^WG_EMBEDDING_API_KEY=.*|WG_EMBEDDING_API_KEY=${NEW_KEY}|" "$BE_ENV"
  if grep -q '^WG_MCP_TOKEN=' "$BE_ENV"; then
    sed -i '' "s|^WG_MCP_TOKEN=.*|WG_MCP_TOKEN=${NEW_MCP}|" "$BE_ENV"
  else
    printf 'WG_MCP_TOKEN=%s\n' "$NEW_MCP" >> "$BE_ENV"
  fi
  echo "✅ 已写入 openclaw/config/.env 与 app/backend/.env"
else
  echo "✅ 已写入 openclaw/config/.env（backend/.env 将在首次启动时自动生成同值）"
fi

echo ""
echo "下一步：双击「重启.command」，AI 功能即用新密钥恢复。"
echo "（换密钥后旧密钥即可作废；本脚本可重复运行。）"
