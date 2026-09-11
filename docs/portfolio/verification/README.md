# 验证证据摘录

日期：2026-09-11。以下是独立演示副本命令输出的摘录，保留测试文件、通过/失败数量及失败断言；移除本机绝对路径与无关构建输出。不包含运行客户数据。

| 证据 | 命令与范围 |
| --- | --- |
| [完整 CI 后端结果](backend-full-ci.txt) | 仓库根目录执行 bash scripts/ci.sh；治理、后端静态检查通过，后端测试失败后停止 |
| [相关集成复跑](backend-integration.txt) | backend 中执行 npm test -- test/team.e2e.spec.ts test/appointment.e2e.spec.ts test/work-order.e2e.spec.ts test/order-confirmation.e2e.spec.ts test/p6-replay.e2e.spec.ts test/home-survey.e2e.spec.ts test/knowledge.e2e.spec.ts test/lead-assign.spec.ts |
| [后端单元专项](backend-unit.txt) | 使用临时配置，保留 SWC 和 test-env-setup，省略数据库 globalSetup；5 个测试文件见输出 |
| [前端专项](frontend-targeted.txt) | frontend 中执行 npm test -- src/views/__tests__/AftercareView.spec.ts src/views/__tests__/AssetsView.spec.ts |

数据库检查均显式连接独立测试库。完整环境、后续前端检查及未验证范围见 [验证记录](../../VALIDATION.md)。摘录用于核对执行结果，不能换算模型准确率或业务成果。
