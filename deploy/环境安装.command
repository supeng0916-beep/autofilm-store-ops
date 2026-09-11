#!/usr/bin/env bash
# 环境一键安装（双击）：把门店电脑装到能跑「启动.command」的状态，小白无需开终端敲命令。
# 自动安装：苹果命令行工具 → Homebrew → Node ≥22 → PostgreSQL 16 + pgvector（开机自启）
#          → 数据库角色 autofilm → AI 网关 OpenClaw（询问，默认安装）。
# 幂等：已装组件自动跳过，可放心重复双击（也可当「环境体检」用）。
# 前置：网络可用；首次安装 Homebrew 时按提示输入一次开机密码（管理员）。
# 装完后双击同目录「启动.command」即可开系统。
set -uo pipefail

say()  { printf '\n== %s ==\n' "$1"; }
ok()   { printf '   ✅ %s\n' "$1"; }
bad()  { printf '   ❌ %s\n' "$1"; }
die()  { bad "$1"; read -r -p "按回车关闭"; exit 1; }
pause(){ read -r -p "按回车关闭"; }

say "AutoFilm Demo 环境安装（联网，首次约 5~20 分钟，取决于网速）"

# —— 0) 系统检查 ——
if [ "$(uname -s)" != "Darwin" ]; then die "本安装器只支持 macOS（当前系统 $(uname -s)）"; fi
if [ "$(uname -m)" = "arm64" ]; then BREW_PREFIX="/opt/homebrew"; else BREW_PREFIX="/usr/local"; fi

# —— 1) 苹果命令行工具（Homebrew 的前置；未装会弹系统安装窗，需要用户点「安装」）——
say "步骤 1/6 · 苹果命令行工具"
if xcode-select -p >/dev/null 2>&1; then
  ok "已安装，跳过"
else
  echo "   弹出的系统窗口里请点「安装」（下载约几百 MB，请耐心等它完成）"
  xcode-select --install >/dev/null 2>&1 || true
  waited=0
  while ! xcode-select -p >/dev/null 2>&1; do
    sleep 5; waited=$((waited + 5))
    if [ "$waited" -ge 900 ]; then die "等待 15 分钟仍未完成命令行工具安装——请在弹窗里点「安装」后重新双击本文件"; fi
  done
  ok "命令行工具安装完成"
fi

# —— 2) Homebrew（已装则只激活；未装则官方脚本安装，会提示输入开机密码）——
say "步骤 2/6 · Homebrew（软件安装器）"
if [ -x "$BREW_PREFIX/bin/brew" ]; then
  ok "已安装，跳过"
else
  echo "   首次安装需要在终端提示时输入一次开机密码（输入时屏幕不显示，输完按回车）"
  if ! NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; then
    die "Homebrew 安装失败——请检查网络（或连手机热点）后重新双击本文件"
  fi
  [ -x "$BREW_PREFIX/bin/brew" ] || die "Homebrew 安装了但未找到（$BREW_PREFIX/bin/brew）——请联系技术支持"
  ok "Homebrew 安装完成"
fi
# 本会话生效 + 写入 ~/.zprofile（双击启动.command 时由登录 shell 读取）
eval "$("$BREW_PREFIX/bin/brew" shellenv)"
if ! grep -qs 'brew shellenv' "$HOME/.zprofile" 2>/dev/null; then
  printf 'eval "$(%s/bin/brew shellenv)"\n' "$BREW_PREFIX" >> "$HOME/.zprofile"
  echo "   [配置] 已把 Homebrew 写入 ~/.zprofile（重启终端后自动生效）"
fi
# 禁用 brew 每次命令前的自动自更新（brew update 慢网络下可卡数分钟；装包不需要最新 brew，
# brew 自身升级属运维动作，由实施方按需执行）
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1

# —— 3) Node.js ≥22（系统运行时）——
say "步骤 3/6 · Node.js（需 ≥22）"
node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }
if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge 22 ] 2>/dev/null; then
  ok "已安装 Node $(node -v)，跳过"
else
  if command -v node >/dev/null 2>&1; then
    echo "   检测到旧版 Node $(node -v 2>/dev/null || echo '?')，将用 Homebrew 安装新版"
  fi
  echo "   正在安装（下载约几十 MB）……"
  if ! brew install --quiet node; then die "Node 安装失败——请检查网络后重新双击本文件"; fi
  ok "Node $(node -v) 安装完成"
fi

# —— 4) PostgreSQL 16 + pgvector（数据库；检测优先——已装就不再碰 brew，避免无谓下载/变更）——
say "步骤 4/6 · PostgreSQL 16 + pgvector"
PG_BIN="$BREW_PREFIX/opt/postgresql@16/bin"
[ -d "$PG_BIN" ] && export PATH="$PG_BIN:$PATH"
vector_ready() {
  psql -d postgres -tAc "SELECT 1 FROM pg_available_extensions WHERE name='vector'" 2>/dev/null | grep -q 1
}
if ! command -v psql >/dev/null 2>&1; then
  echo "   未安装——正在安装 PostgreSQL 16 + pgvector（首次需下载/编译，约几分钟）……"
  if ! brew install --quiet postgresql@16 pgvector; then die "PostgreSQL/pgvector 安装失败——请检查网络（或连手机热点）后重新双击本文件"; fi
elif ! vector_ready; then
  echo "   检测到 PostgreSQL 但缺 pgvector 向量扩展——正在补装……"
  if ! brew install --quiet pgvector; then die "pgvector 安装失败——请检查网络后重新双击本文件"; fi
else
  ok "已安装，跳过"
fi
# postgresql@16 为 keg-only（不进默认 PATH）：按 brew 官方建议把工具目录写入配置
if ! grep -qs 'postgresql@16/bin' "$HOME/.zprofile" 2>/dev/null; then
  printf 'export PATH="%s:$PATH"\n' "$PG_BIN" >> "$HOME/.zprofile"
  echo "   [配置] 已把 psql 等数据库工具写入 ~/.zprofile"
fi
export PATH="$PG_BIN:$PATH"
# 设为开机自启（已启动则无变化），然后等数据库就绪
if ! brew services start postgresql@16 >/dev/null 2>&1; then die "数据库自启动设置失败——请联系技术支持"; fi
ready=0
for _ in $(seq 1 30); do
  if pg_isready -q 2>/dev/null; then ready=1; break; fi
  sleep 1
done
[ "$ready" = "1" ] || die "数据库启动超时——请重新双击本文件再试一次，仍失败请联系技术支持"
ok "PostgreSQL 运行中（已设开机自启）"

# —— 5) 数据库角色 autofilm（启动.command 以该角色建库/迁移；此前靠手工创建，新机器会卡在这）——
say "步骤 5/6 · 数据库账号 autofilm"
if psql -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='autofilm'" 2>/dev/null | grep -q 1; then
  ok "已存在，跳过"
else
  # SUPERUSER：迁移需 CREATE EXTENSION vector（非超级用户无权）；本地 socket 默认信任连接，口令仅兜底
  if ! psql -d postgres -c "CREATE ROLE autofilm LOGIN SUPERUSER PASSWORD 'autofilm';" >/dev/null 2>&1; then
    die "数据库账号创建失败——请联系技术支持"
  fi
  ok "已创建（账号 autofilm / 口令 autofilm，仅本机使用）"
fi

# —— 6) AI 网关 OpenClaw（可选：不装则系统照常运行，仅 AI 功能提示暂不可用）——
say "步骤 6/6 · AI 网关 OpenClaw（可选）"
if command -v openclaw >/dev/null 2>&1; then
  ok "已安装 $(openclaw --version 2>/dev/null || echo '')，跳过"
else
  printf '   安装 AI 网关吗？（建议安装，直接回车=安装；输入 n 跳过）'
  read -r reply
  if [ "${reply:-y}" = "n" ]; then
    echo "   已跳过——以后想启用 AI，重新双击本文件即可补装"
  else
    # 固定已验证版本（网关版本敏感：事件格式变更曾致输出解析失败，升级须重跑回归——
    # 见 docs/acceptance/P6-06-已知限制.md；门店升级由实施方发新版本安装指令）
    echo "   正在安装 OpenClaw 2026.7.1-2（已验证版本）……"
    if ! npm install -g openclaw@2026.7.1-2; then die "OpenClaw 安装失败——可先跳过（重跑本文件，到这步输入 n），系统业务功能不受影响"; fi
    ok "OpenClaw 安装完成"
  fi
fi

# —— 体检清单 ——
say "环境体检"
FAIL=0
if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge 22 ] 2>/dev/null; then
  ok "Node.js $(node -v)"
else bad "Node.js ≥22 未就绪"; FAIL=1; fi
if command -v psql >/dev/null 2>&1; then
  ok "PostgreSQL 客户端 $(psql --version 2>/dev/null | awk '{print $3}')"
else bad "psql 未找到（重启终端后重试，仍失败联系技术支持）"; FAIL=1; fi
if pg_isready -q 2>/dev/null; then ok "数据库运行中"
else bad "数据库未运行（双击本文件重试）"; FAIL=1; fi
if psql -d postgres -tAc "SELECT 1 FROM pg_available_extensions WHERE name='vector'" 2>/dev/null | grep -q 1; then
  ok "pgvector 向量扩展可用"
else bad "pgvector 未安装（双击本文件重试）"; FAIL=1; fi
if psql -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='autofilm'" 2>/dev/null | grep -q 1; then
  ok "数据库账号 autofilm"
else bad "数据库账号 autofilm 缺失（双击本文件重试）"; FAIL=1; fi
if command -v openclaw >/dev/null 2>&1; then
  ok "AI 网关 OpenClaw（AI 功能可用）"
else
  echo "   ⚠️  未安装 OpenClaw——系统可正常使用，AI 功能暂不可用（双击本文件可补装）"
fi

echo ""
if [ "$FAIL" = "0" ]; then
  echo "✅ 环境就绪！接下来双击同目录的「启动.command」，浏览器会自动打开系统。"
else
  echo "❌ 有项目未就绪——请重新双击本文件再试一次，仍失败请把本窗口截图发给技术支持。"
fi
pause
