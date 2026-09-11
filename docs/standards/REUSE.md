# 现有能力索引与防复发入口

这是导航，不替代源码。新增功能时先从对应入口搜索定义、调用方和测试。路径均相对仓库根目录。

## 常用能力

| 场景 | 首选入口 | 先例 / 注意事项 |
|---|---|---|
| 前端 API、鉴权、错误提示 | `frontend/src/api/http.ts` | `frontend/src/api/marketing.ts`、`frontend/src/api/__tests__/http.spec.ts`；已含 token/刷新/统一错误处理，AI 接口须检查专属 timeout |
| 前端权限 | `frontend/src/composables/usePermission.ts` | `frontend/src/views/WorkOrdersView.vue`；仅控制 UI，后端权限仍需校验 |
| 统一提示样式与去重 | `frontend/src/utils/message-ux.ts` | `frontend/src/main.ts` 已全局安装，勿再包装第二套提示体系 |
| 页面标题、空态、统计卡、筛选栏 | `frontend/src/components/ui/` | 先搜索 PageHeader / EmptyState / StatCard / FilterBar 的调用方 |
| 客资展示标签与时间 | `frontend/src/components/leads/leadDisplay.ts` | 面向客资；时间空值为长横线。其他页面存在短横线差异，迁移前核对展示契约 |
| 鉴权素材、媒体显示 | `frontend/src/api/asset.ts` | 查现有 blob/文件加载流程，避免受保护文件直接用于 img URL |
| 后端权限 | `backend/src/modules/auth/permission.guard.ts`、`require-permission.decorator.ts` | `docs/PERMISSION_MATRIX.md` 为权限导航 |
| 后端错误 | `backend/src/common/errors/` | 复用错误码、AppException、统一异常过滤器 |
| 审计 | `backend/src/common/audit/` | 复用 AuditService 和事件类型；先查现有服务调用 |
| 业务数据库 | `backend/src/prisma/prisma.service.ts` | 遵守服务/仓储分层；不要在 controller 新增直接查库 |
| 脚本数据库连接检查 | `backend/scripts/db-env.ts` | `check-db.ts`、`seed-knowledge.ts` 已用 requireDbUrl；查库/种子不是只读源码检查 |
| AI 任务提交与回调 | `backend/src/modules/ai-dispatch/ai-dispatch.service.ts`、`ai-callback.service.ts` | 已有注册/归一化/校验/审计链，勿另起模型直连通道 |
| AI 输出归一化与检查 | `backend/src/modules/ai-dispatch/output-normalize.util.ts`、`output-lint.ts` | `backend/test/output-lint.spec.ts`、`output-lint.e2e.spec.ts` |
| AI 载荷脱敏 | `backend/src/modules/ai-dispatch/masker.ts` | 先看对应 masker 测试与 HANDOFF §8 的键名/时间戳陷阱 |
| 运行时门店查询工具 | `backend/src/modules/ai-dispatch/store-mcp/store-mcp.tools.ts` | STORE_MCP_TOOL_SPECS 与 StoreMcpTools；开发辅助工具和业务 MCP 工具是不同层次 |
| 测试唯一数据 / 假网关 | `backend/test/helpers/unique.ts`、`fake-openclaw-gateway.ts` | 先检查测试库隔离与全局 setup，避免复制造数逻辑 |
| 评测 / 性能基准 | `backend/scripts/eval.ts`、`benchmark.ts` | `npm run eval` / `npm run bench`；先读支持参数与副作用，真实评测可能联网、写数据、产生模型费用。真实评测可联网、写数据并产生模型费用，运行前须确认隔离配置。 |
| 全量门禁 / 治理快检 | `scripts/ci.sh`、`scripts/governance.mjs` | `make lint` 为全量；治理快检见下文 |

## 开发前的最短流程

当前需求以 `docs/specs/V2.0-文件索引.md` 对应四份用户原件为准；复核与分批计划复用 `HANDOFF.md`，开发模型选择复用 `docs/standards/MODEL_WORKFLOW.md`。这些是需求/协作导航，不是运行时技能或新评测程序。

1. 按业务词和能力名搜索，例如 `rg -n 'requireDbUrl' backend/scripts`、`rg -n 'usePermission' frontend/src`。
2. 阅读候选实现、至少一个实际调用方、相关测试。
3. 判断直接复用、兼容扩展或新增；新增理由应说明语义差异，不能仅写“更方便”。
4. 修复完成后把历史错误转为回归测试；仅增加文档提醒不足以防止复发。

## 已知陷阱与对应防线

| 陷阱 | 当前防线 / 开发动作 |
|---|---|
| migrate diff 误生成 HNSW DROP INDEX | `node scripts/governance.mjs` 扫描所有 migration.sql（含新文件），忽略注释/字符串；历史 p5_delivery 仅原路径原 SHA256 放行，新路径或内容变化不继承豁免 |
| Vue 页面持续变大 | 同一治理入口检查全部 frontend/src/**/*.vue；新文件 ≤300 行，旧文件按初始基线限额，含空行/注释；拆分时下调基线，重命名不自动继承豁免 |
| API 超时、鉴权文件加载重复踩坑 | 复用 http.ts / asset.ts，参照已有 API 测试；AI 请求不能无意识沿用 15s 默认值 |
| 测试污染 / 数据重复 | 复用 helpers/unique.ts 与现有测试库配置，按现有集成测试生命周期准备/清理数据 |
| “已复制”误作“已发送” | 保持 sales-draft.spec.ts 的既有回归语义，不在 UI 或事件中重新混用 |

治理快检（无需数据库或网关）：

```bash
node --test scripts/governance.test.mjs
node scripts/governance.mjs
```

这些检查已接入 `scripts/ci.sh` 首段。它们不是重复代码语义分析器，也不保证 Agent 总能复用正确；搜索约定与代码审查仍然必要。迁移检查不覆盖动态/过程体 SQL、间接 DROP TABLE/CASCADE。基线文件需要和业务代码一样审查，不能通过提高限额绕过检查。

## 规范与现状

`STANDARDS.md` 已于2026-09-09按用户授权对齐四份V2文件，原规则可查Git历史。当前仍存在历史差距：API类型有手写定义、部分controller直接查库、旧Vue超长。不要据此复制违规先例，也不要把索引误当“已实现OpenAPI自动生成”的证明。处理相关模块时有针对性收敛，不为本次复核启动无关全仓重构。
