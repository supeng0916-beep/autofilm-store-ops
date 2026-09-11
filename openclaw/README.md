# OpenClaw 接入与 Agent 工程实现

本目录保存 AutoFilm Ops 的网关配置模板、运行时技能及技能快照。项目的 Agent 推理与工具调用由外部 OpenClaw Gateway 执行，后端负责角色上下文、任务调度、结果校验和业务衔接。项目概览见 [README](../README.md#ai-agent-核心设计)。

这份说明以仓库中的适配代码为依据，不把历史调试记录当作当前网关版本的兼容性保证。公开版不提供真实凭据、知识正文或模型效果数据。

## 一次 Agent run 如何执行

1. 业务服务根据任务类型准备上下文；对话入口由服务端解析角色，老板与店长使用不同的聚合快照。
2. `AiDispatchService` 查询任务注册表，检查开关与日预算，对上下文脱敏并扫描残留，再创建任务和状态事件。
3. `WsOpenClawGateway` 建立 WebSocket 连接并进行 token 鉴权，通过 `agent` RPC 发起执行，使用任务 ID 作为幂等键和独立会话键。
4. 网关执行技能并产生事件流，按需调用白名单工具；适配器收集文本，再通过 `agent.wait` 获取终态。助手页面通过后端 SSE 接收增量内容。
5. 结果统一交给 `AiCallbackService`：任务类型交叉检查、结果归一化、Zod 校验、已注册的 `postLint` 检查，最后保存结果与状态。HTTP 回调兼容入口另有 HMAC 验签，与 WebSocket 结果共用受理逻辑。
6. 网关适配器尝试通过 `sessions.usage` 补取用量；后端记录 token、模型与成本估算。业务服务把结果组织成建议、草稿或训练内容。

常规成功路径为 `pending → dispatched → callback_received → validated → done`。超时、结构错误等进入降级或失败路径；重试创建新任务。状态表由程序控制，人工接管登记事件不会伪造一个“执行成功”状态。

## 技能、工具与业务服务的职责

| 层次 | 职责 | 代码入口 |
| --- | --- | --- |
| 角色与上下文 | 选择助手人格、聚合当前业务事实、显式携带对话历史 | [agent/](../backend/src/modules/agent/) |
| 任务注册表 | 关联任务类型、技能名称、输出 Schema、时限、约束及可选版本 / 校验钩子 | [ai-dispatch.registry.ts](../backend/src/modules/ai-dispatch/ai-dispatch.registry.ts) |
| 运行时技能 | 定义任务目标、受众、输出格式、事实边界和工具使用策略 | [skills/](skills/) |
| 网关适配器 | RPC、事件收集、独立会话、终态等待与用量读取 | [ws-openclaw.gateway.ts](../backend/src/modules/ai-dispatch/ws-openclaw.gateway.ts) |
| 业务 MCP | 提供有限的只读数据查询，校验参数，限制输出，记录审计 | [store-mcp/](../backend/src/modules/ai-dispatch/store-mcp/) |
| 业务服务 | 权限检查、人工改写、知识审批、状态流转与事件落库 | [草稿服务](../backend/src/modules/lead/ai/sales-draft.service.ts)、[知识服务](../backend/src/modules/knowledge/knowledge.service.ts) |

可先阅读 [老板助手](skills/skill-boss-agent/SKILL.md)、[销售助手](skills/skill-sales-agent/SKILL.md)、[销售陪练](skills/skill-sales-roleplay/SKILL.md)，再对照各模块的任务注册与输出校验。技能中的要求不自动等于后端已强制执行的规则，应同时检查调用方和测试。

## MCP 查询与调用治理

端点 `POST /api/v1/mcp` 支持 `initialize`、`tools/list`、`tools/call`，采用 JSON-RPC 消息结构。`WG_MCP_TOKEN` 缺失或不匹配时返回 401。

四个工具为 `store_overview`、`store_appointments`、`store_work_orders`、`store_knowledge_search`。在网关配置中，它们以 `store__` 前缀加入工具白名单。查询使用字段选择与结果上限，文本出口执行脱敏；工具定义见 [STORE_MCP_TOOL_SPECS](../backend/src/modules/ai-dispatch/store-mcp/store-mcp.tools.ts)。

后端审计是本项目核查工具调用的入口：

- `ai.mcp.tool_call`：记录通过参数入口的调用尝试，包括执行错误；字段含工具名、脱敏参数、归属任务与调用序号。
- `ai.mcp.call_rejected`：记录归属任务的超限调用，拒绝执行工具。
- 任务内第 4 次查询开始拒绝执行；无在途任务的调用不计入此限额，仍须通过网关 token 鉴权。

网关模板还允许 `read` 读取技能、`session_status` 与 `web_search`；未把写文件、执行命令、发送消息类工具加入 `tools.allow`。模板指定独立工作区并开启 `workspaceOnly`，接入时需确认所用网关版本实际执行这些配置。不要把业务资料或凭据放进 Agent 可读工作区。

## 三条知识读取路径

| 入口 | 检索方式 | 当前过滤与输出 |
| --- | --- | --- |
| 独立知识问答 `KnowledgeSearchService` | `RagService` 做向量相似度 + 关键词混合召回 | RAG 查询已生效条目，问答服务再过滤 `licensed`；携带来源与版本，无可用条目时直接返回不确定 |
| 角色对话 `AgentService.retrieveKnowledge` | 对问题分词，按标题 / 正文匹配并排序 | 查询已生效条目，注入标题、来源与正文片段；当前未在该查询处过滤 `licensed` |
| MCP `store_knowledge_search` | 标题 / 正文的关键词 `contains` 查询 | 查询已生效条目，返回脱敏摘要与来源；当前未在该查询处过滤 `licensed` |

这三条路径有不同的工程契约。独立问答需要 Embedding 配置；未配置时，该 RAG 实现返回空结果，关键词分支也不会单独执行。对话和 MCP 的关键词查询不依赖 Embedding。公开版三条路径共用的知识数据默认为空。

## 可选接入步骤

先按根目录 [启动说明](../README.md#启动服务) 运行独立数据库和前后端。OpenClaw 本体需要单独安装；安装和启动方式按实际使用版本配置，本仓库不包含网关安装器。

1. 从 [config/.env.example](config/.env.example) 准备本机 `openclaw/config/.env`，填写自己的模型凭据与随机 token。网关进程需要能读取这些环境变量，复制文件本身不会自动完成进程配置。
2. 在后端本机 `backend/.env` 填写网关 WebSocket 地址；与网关保持相同的 Gateway token 和 MCP token。MCP token 至少 16 字符，具体校验见 [环境 Schema](../backend/src/common/config/env.schema.ts)。
3. 以 [config/openclaw.json](config/openclaw.json) 为模板配置网关。核对模型供应商、模型标识、技能目录、工作区和 MCP 地址；相对路径以实际网关工作目录为准，需要时在本机配置中改成绝对路径。
4. 启动网关并重新启动后端，在“AI 通道”检查连接与技能开关。先执行无客户数据的通道任务，再使用自己编写的虚构案例验证助手与工具查询。
5. 需要独立知识问答时，再填写 Embedding 配置并按页面流程批准虚构知识生效。使用自己的独立数据库，确认入库与检索结果。

| 配置 | 放置位置 | 用途 |
| --- | --- | --- |
| `WG_OPENCLAW_GATEWAY_WS_URL` | 后端环境 | 默认模板网关地址为 `ws://127.0.0.1:18789` |
| `WG_OPENCLAW_GATEWAY_TOKEN` | 后端与网关环境，同值 | 后端连接网关的鉴权 |
| `WG_OPENCLAW_PRIMARY_KEY` | 网关环境 | 模型供应商凭据；模板通过 SecretRef 引用 |
| `WG_MCP_TOKEN` | 后端与网关环境，同值 | 网关访问后端四个 MCP 工具 |
| `WG_EMBEDDING_API_URL` / `WG_EMBEDDING_API_KEY` / `WG_EMBEDDING_MODEL` | 后端环境 | 向量生成与检索 |
| `WG_AI_DAILY_BUDGET_FEN` | 后端环境 | 日预算拒收线，单位为分 |
| `WG_AI_TASK_MAX_TOKENS` | 后端环境 | 单任务用量告警阈值 |
| `WG_AI_MODEL_PRICES_FEN_PER_MTOK` | 后端环境 | 按模型配置 token 单价，用于费用估算 |

实际模型可用性、价格和网关协议兼容性需要在接入时核验。保留默认关闭的定时通知配置即可完成交互展示；接入助手本身不要求启用对外消息渠道。

## 当前边界

- **部署范围**：当前代码以单实例、单业务空间为背景。MCP 使用共享网关令牌，未逐调用绑定终端用户权限；调用计数归属最近开始的在途 run，并发时可能归错。扩展多租户或高并发前需要补充明确的身份与任务绑定。
- **知识授权**：独立问答有 `licensed` 过滤，角色对话与 MCP 查询目前仅检查生效状态。共享目录中不能混入未经授权的资料；不要将三条路径宣传成同一种授权检索实现。
- **输出审核**：Zod 约束结构，`postLint` 只检查已接入的规则，无法证明全部事实正确；SSE 增量预览在终稿校验前到达。业务内容仍需人工确认。
- **费用与恢复**：日预算在新任务提交前检查，单任务 token 阈值只告警；成本依赖可取得的用量与配置单价。超时降级和人工接管登记不等于已取消网关正在运行的任务。
- **版本治理**：已实现技能快照、版本记录和受角色限制的回滚接口。固定评测与发布审批属于发布要求，当前接口不构成自动审批发布平台。
- **展示与评测**：合成截图用于展示交互，假网关测试用于验证程序行为；脱敏后的技能没有在本轮执行真实模型业务评测，不提供准确率、营收提升或生产可用性承诺。

## 验证入口

| 检查对象 | 现有测试 / 脚本 |
| --- | --- |
| 调度、结果校验、重复回调 | [ai-dispatch.spec.ts](../backend/test/ai-dispatch.spec.ts)、[ai-callback.spec.ts](../backend/test/ai-callback.spec.ts) |
| MCP 令牌、字段输出、限次与审计 | [store-mcp.e2e.spec.ts](../backend/test/store-mcp.e2e.spec.ts)、[mcp-governor.spec.ts](../backend/test/mcp-governor.spec.ts) |
| 脱敏、格式归一化与输出规则 | [masker.spec.ts](../backend/test/masker.spec.ts)、[ai-output-normalize.spec.ts](../backend/test/ai-output-normalize.spec.ts)、[output-lint.spec.ts](../backend/test/output-lint.spec.ts) |
| 草稿版本与人工事件 | [sales-draft.spec.ts](../backend/test/sales-draft.spec.ts) |
| 技能快照、版本记录与回滚 | [skill-version-shadow.e2e.spec.ts](../backend/test/skill-version-shadow.e2e.spec.ts) |
| 合成案例与模型评测入口 | [评测夹具](../backend/test/eval/)、[eval.ts](../backend/scripts/eval.ts) |

测试步骤及本轮已执行结果见 [VALIDATION](../docs/VALIDATION.md)。数据库测试会写测试库，模型评测可能联网并产生费用；阅读源码和文档不需要启动这些服务。
