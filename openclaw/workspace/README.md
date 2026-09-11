# openclaw/workspace —— 网关 agent 工作区（刻意保持干净）

本目录是 openclaw 网关 main agent 的 workspace（`openclaw.json → agents.defaults.workspace`，相对仓库根解析）。

**边界语义（R2-01，2026-09-09 二轮复验）**：非沙箱模式下 read 工具受 workspace-root 守卫——可读范围 = 本目录 + 技能目录（skills.load.extraDirs），目录外读取在执行层被拒（`outside-workspace`）。write/edit/exec/message 等已在 `tools.allow` 白名单外整体禁用。

**纪律**：

- 本目录内任何文件都可能被模型读取并进入上下文——**只放无害内容**，绝不放密钥、客户数据、内部凭证。
- `agents.defaults.skipBootstrap: true` 已禁用 IDENTITY/SOUL/USER/AGENTS 引导文件生成（业务人设全部由技能承载，引导文件既是泄漏面也是提示词污染面）。
- 评测发现的历史越界读取（~/.openclaw/workspace 下的引导文件与残留）随本目录切换整体移出边界；旧目录内容不再可达。
