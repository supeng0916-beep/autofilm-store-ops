/** 网关令牌 provider token（M02 Task 1）：独立常量文件切断 controller ↔ module 的循环引用
 * （ESM 循环求值会让装饰器拿到 undefined，注入元数据丢失）。测试可用 buildApp extraOverrides
 * 覆盖为 '' 验证未配置时 fail-closed。 */
export const STORE_MCP_TOKEN = 'STORE_MCP_TOKEN';
