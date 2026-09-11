/** Vitest setupFile：在每个测试文件的模块导入之前执行。
 * ConfigModule.forRoot 在 AppModule 导入时即对环境求值（ESM import 提升早于 beforeAll），
 * 各 spec 在 beforeAll 里赋值 WG_DATABASE_URL 对已求值的配置无效——
 * 曾导致「一次运行的首个套件落开发库、后续套件落测试库」的非确定行为，
 * 违背 TEST_DATABASE_URL「测试库连接串唯一出口」的设计与开发/测试隔离红线。
 * 此处是恢复该设计的最小注入点：所有集成测试套件确定命中测试库。 */
import { TEST_DATABASE_URL, TEST_MCP_TOKEN } from './test-env';

process.env.WG_DATABASE_URL = TEST_DATABASE_URL;
// P3-00：通道门禁（AiSwitchService.assertEnabled）要求 WG_OPENCLAW_GATEWAY_WS_URL 非空才放行。
// 测试环境统一注入假地址（hermetic，不连真实 OpenClaw）；OPENCLAW_GATEWAY 由各 spec
// override 为 FakeGateway，故此处只满足「通道已配置」语义，不产生真实连接。
process.env.WG_OPENCLAW_GATEWAY_WS_URL ??= 'ws://127.0.0.1:18789';
process.env.WG_OPENCLAW_GATEWAY_TOKEN ??= 'test-gateway-token';

// 门店 MCP 端点（M02 Task 1）：网关 Bearer 令牌须在 AppModule 求值前注入（同上口径），
// store-mcp.e2e 引用 TEST_MCP_TOKEN；未命中本注入的套件不受影响（不调 /api/v1/mcp）
process.env.WG_MCP_TOKEN ??= TEST_MCP_TOKEN;

// P4-06 校准：开发环境 .env 配置了 WG_RAG_MIN_SIMILARITY=0.3（生产口径），
// 测试库数据与开发库不同，阈值语义不可迁移——测试统一回退关闭态
process.env.WG_RAG_MIN_SIMILARITY = '0';
