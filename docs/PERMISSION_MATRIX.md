# 权限实现导航

这是作品集代码的阅读入口，不包含实际团队编制、人员调整或内部授权记录。实际权限以 [permissions.ts](../backend/src/modules/auth/permissions.ts)、控制器守卫和业务服务为准。

| 角色代码 | 主要用途 | 阅读时关注 |
| --- | --- | --- |
| boss | 经营查看与业务审批 | 经营权限与技术配置权限分开 |
| store_manager | 客资、排期与交付流程 | 对象范围与具体权限点 |
| sales_ops | 客资跟进与内容任务 | 本人负责对象与可分配范围 |
| recorder | 授权施工信息录入 | 仅保留工作所需入口 |
| sys_admin | 账号、系统配置与集成 | 技术特权不自动开放所有业务数据 |

前端 [usePermission](../frontend/src/composables/usePermission.ts) 控制可见交互；后端 [PermissionGuard](../backend/src/modules/auth/permission.guard.ts) 检查权限点，业务服务继续检查对象归属。

Agent 对话根据服务端角色或显式人格映射选择技能；MCP 端点使用单独的共享网关令牌，当前没有逐工具绑定最终用户权限。人格路由不能当成完整的工具授权模型，详见 [架构说明](portfolio/ARCHITECTURE.md)。

建议结合 [RBAC 测试](../backend/test/rbac.spec.ts)、[草稿归属测试](../backend/test/sales-draft.spec.ts)、[角色路由测试](../backend/test/agent-persona.e2e.spec.ts) 阅读。测试里存在断言不等于本轮已执行，结果见 [VALIDATION](VALIDATION.md)。
