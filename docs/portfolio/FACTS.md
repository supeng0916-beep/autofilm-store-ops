# 事实清单与证据索引

核验日期：2026-09-11。输入代码基线：`447c15898d8c9c63e22f18381ed7e81cb88abcf1`。先核对规则、实现、模型、测试与输入历史，再据此编写招聘展示材料。输入历史已发现隐私残留，不进入发布候选。

## 证据分级

- **实现事实**：从当前源码、数据库定义或配置中直接确认，不代表已通过真实业务验收。
- **测试契约**：测试包含对应断言；未在本轮执行的测试，不写成“本轮通过”。
- **执行证据**：本轮命令输出或保留的可追溯记录；必须写明版本、环境和范围。
- **待本人确认**：具体决策背景、真实部署和业务效果，不能从代码作者字段推断。

## 可用于展示的事实

| 编号 | 核实后的表述 | 主要证据 | 限制 |
| --- | --- | --- | --- |
| F01 | 系统将客资跟进、草稿、知识、预约交付和经营查看放在同一应用中 | [前端路由](../../frontend/src/router/index.ts)、[Prisma 模型](../../backend/prisma/schema.prisma) | 证明有页面与数据模型，不能证明实际部署规模或收益 |
| F02 | 角色对话由后端选择人格，老板与店长有独立上下文聚合器 | [PersonaService](../../backend/src/modules/agent/persona.service.ts)、[AgentService](../../backend/src/modules/agent/agent.service.ts)、[角色测试](../../backend/test/agent-persona.e2e.spec.ts) | 属于角色路由，不是自动相互委派的多 Agent 网络 |
| F03 | AI 任务共用注册表、开关、预算、输入脱敏和状态事件 | [调度服务](../../backend/src/modules/ai-dispatch/ai-dispatch.service.ts)、[调度测试](../../backend/test/ai-dispatch.spec.ts) | 业务实现事实，不代表绝对无泄漏或预算绝不超支 |
| F04 | 网关适配器为每个任务提供独立会话键，以 RPC 发起执行并收回结果 | [网关适配器](../../backend/src/modules/ai-dispatch/ws-openclaw.gateway.ts)、[假网关测试](../../backend/test/ws-openclaw-gateway.spec.ts) | 网关会话隔离不等于全部前端账号会话问题已解决 |
| F05 | 结果经归一化、任务输出 Schema 及已接入的规则检查；状态由程序迁移 | [结果受理](../../backend/src/modules/ai-dispatch/ai-callback.service.ts)、[回调测试](../../backend/test/ai-callback.spec.ts) | Schema 证明结构符合契约，不能证明语义完全正确；流式预览先于终稿审核 |
| F06 | 提供四个只读业务 MCP 工具；在途归属任务超过三次调用时拒绝查询 | [工具定义](../../backend/src/modules/ai-dispatch/store-mcp/store-mcp.tools.ts)、[控制器](../../backend/src/modules/ai-dispatch/store-mcp/store-mcp.controller.ts)、[计数测试](../../backend/test/mcp-governor.spec.ts) | 共享网关令牌、按最近在途任务归属，尚非多租户逐用户授权 |
| F07 | 独立知识问答使用向量与关键词混合召回，并在问答服务过滤授权标记 | [RAG](../../backend/src/modules/knowledge/rag.service.ts)、[问答服务](../../backend/src/modules/knowledge/knowledge-search.service.ts) | 对话预检索与 MCP 关键词查询是另外两条路径，授权过滤不同 |
| F08 | AI 草稿、人工改写、复制与登记发送分别存储和留痕 | [草稿服务](../../backend/src/modules/lead/ai/sales-draft.service.ts)、[草稿测试](../../backend/test/sales-draft.spec.ts)、[数据模型](../../backend/prisma/schema.prisma) | 登记发送不是系统读取到真实聊天记录，也不触发对外发送 |
| F09 | 陪练分对话与点评任务，提炼结果先进入知识草稿 | [陪练服务](../../backend/src/modules/agent/roleplay.service.ts)、[经验提炼测试](../../backend/test/experience-extract.e2e.spec.ts) | 训练样本不能当真实客户反馈；尚未证明训练效果 |
| F10 | 记录任务用量、费用估算、技能版本；支持开关与快照回滚 | [成本服务](../../backend/src/modules/ai-dispatch/ai-cost.service.ts)、[版本服务](../../backend/src/modules/ai-dispatch/skill-version.service.ts)、[成本测试](../../backend/test/ai-cost.spec.ts) | 单任务 token 阈值仅告警；回滚接口不是完整的自动评测发布平台 |
| F11 | 数据模型分开保存任务、任务事件、业务事件、知识与训练会话 | [Prisma 模型](../../backend/prisma/schema.prisma) 中 AiTask / AiTaskEvent / LeadEvent / KnowledgeItem / RoleplaySession / RoleplayTurn | 部分关联用逻辑 ID 表达，不能把所有箭头都称为数据库外键 |
| F12 | 五张界面截图使用合成数据，知识初始化数组为空 | [截图说明](../screenshots/README.md)、[空知识测试](../../backend/test/portfolio-data.spec.ts)、[初始化数据](../../backend/scripts/seed-knowledge.data.ts) | 截图中的金额、采用率、成功数和耗时都是展示占位值，不是成果数字 |

## Git 历史能证明什么

本轮阅读了独立副本的两个可达提交：

| 提交 | 内容 | 能支持的结论 |
| --- | --- | --- |
| `5acd089` | 原导出根快照，本轮查出仍有隐私残留 | 该输入历史从快照开始，不能证明原开发过程，也不能继续公开 |
| `447c158` | AI Agent 介绍文档更新 | 后续展示文档有独立变更记录 |

原开发仓库和私有归档未作为本轮候选历史来源。最终候选重新初始化 Git，仅保留已复核文件的单个无父提交，不携带上述旧对象。提交作者、文件行数、技能数量均不能推导本人独立完成的比例或开发工时。

## 数字使用规则

本轮招聘材料不使用营收提升、节省工时、准确率、性能提升或用户规模等成果数字，因为尚未收到可核对证据。

“四个工具”“三次查询限额”是代码常量；“五张截图”是文件数量，均非业务成果。历史验证记录中的测试通过数仅保留为历史记录，见 [VALIDATION](../VALIDATION.md)，不能换算模型质量。旧部署容量文档里的性能数字未附本轮可复核的原始日志，不采用到新展示材料中。

## 待本人补充

项目周期、实际使用背景与可证明成果，统一在 [贡献确认表](CONTRIBUTIONS.md) 补充。作者已在本轮确认整个项目个人独立开发，展示可使用该身份；不能由此推断开发周期、业务效果或未说明的决策经历。
