/** 测试库连接串唯一出口（P1 遗留 T4-1/M8 回收）：
 * 优先 WG_TEST_DATABASE_URL（CI/异机可覆盖），默认本地 autofilm_test。
 * 禁止在测试文件中再硬编码测试库连接串。 */
export const TEST_DATABASE_URL =
  process.env.WG_TEST_DATABASE_URL ?? 'postgresql://autofilm:autofilm@localhost:5432/autofilm_test';

/** 门店 MCP 端点（M02）测试令牌：test-env-setup 注入 WG_MCP_TOKEN，各 spec 统一引用本常量 */
export const TEST_MCP_TOKEN = 'test-mcp-token-0246802789abcdef';
