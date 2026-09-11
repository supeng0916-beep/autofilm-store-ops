import { z } from 'zod';

/** 环境变量 schema：所有运行时配置的唯一入口（规范 S04/S09） */
export const envSchema = z.object({
  NODE_ENV: z.enum(['dev', 'test', 'prod']).default('dev'),
  WG_PORT: z.coerce.number().default(8000),
  WG_DATABASE_URL: z.string().min(1, '缺少 WG_DATABASE_URL（数据库连接串）'),
  WG_JWT_SECRET: z.string().min(32, 'WG_JWT_SECRET 至少 32 字符'),
  // 布尔解析用 enum+transform 而非 z.coerce.boolean()：后者等价 Boolean(input)，字符串 'false' 会被误判为 true
  WG_DEBUG: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
  // —— AI 通道（P3-00，Gateway 协议 WebSocket+RPC）——
  // 网关连接与鉴权；两者缺省 = 通道未开启，submitTask 门禁拒绝（D-P3-1），不影响其余业务启动
  WG_OPENCLAW_GATEWAY_WS_URL: z.url().optional(),
  WG_OPENCLAW_GATEWAY_TOKEN: z.string().min(1).optional(),
  // 回调方向 HMAC 密钥（OpenClaw → NestJS；P3-00 起仅测试/echo 模式使用，回调端点保留）
  WG_AI_CALLBACK_SECRET: z.string().min(16).optional(),
  // 成本限额（机制不省；测试期为高额熔断线，正式数值由 leader 观察消耗区间后定，D-P2-6）
  WG_AI_DAILY_BUDGET_FEN: z.coerce.number().int().nonnegative().default(10000),
  WG_AI_TASK_MAX_TOKENS: z.coerce.number().int().positive().default(20000),
  // —— 全站接口限流（快修批次，防爆破/防滥用）——
  // 同一来源在 WG_RATE_LIMIT_TTL 秒窗口内最多 WG_RATE_LIMIT_MAX 次请求，超限 429
  WG_RATE_LIMIT_TTL: z.coerce.number().int().positive().default(60),
  WG_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  // 提交超时与任务默认时限（秒）
  WG_AI_SUBMIT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  WG_AI_DISPATCH_DEADLINE_S: z.coerce.number().int().positive().default(300),
  // 模型单价表（2026-08-28 P5，分/每百万 tokens）：JSON，如
  // {"MiniMax-M3":{"input":210,"output":420}}；缺省用 ai-pricing 内置默认（MiniMax-M3 官方五折价）。
  // 网关不上报金额，成本按该表估算（WG_AI_MODEL_PRICES_FEN_PER_MTOK）
  WG_AI_MODEL_PRICES_FEN_PER_MTOK: z.string().optional(),
  // —— P4 RAG 向量检索 ——
  // Embedding API（MiniMax）：未配置时 RAG 检索返回空结果而非抛错
  WG_EMBEDDING_API_URL: z.string().url().optional(),
  WG_EMBEDDING_API_KEY: z.string().min(1).optional(),
  WG_EMBEDDING_MODEL: z.string().default('embo-01'),
  WG_RAG_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0),
  // 施工照片本地存储目录（P5-04；相对 backend 运行目录）
  WG_UPLOAD_DIR: z.string().default('uploads'),
  // 素材待入库文件夹（v1.5 批量导入）：留空=关闭扫描；门店把素材丢入该目录，系统定时入库
  WG_IMPORT_WATCH_DIR: z.string().optional(),
  // 生产模式静态服务前端构建产物（deploy/package.sh 打包时设置；设置后单进程即全系统）
  WG_STATIC_DIR: z.string().optional(),
  // —— 门店 MCP 端点（M02）：AI 网关 Bearer 令牌 ——
  // 调用方是网关不是人，不挂用户 JWT；未配置 = 端点 fail-closed（一律 401），不影响其余业务启动
  WG_MCP_TOKEN: z.string().min(16, 'WG_MCP_TOKEN 至少 16 字符').optional(),
});

export type Env = z.infer<typeof envSchema>;

/** @nestjs/config validate 回调：失败时抛出指明缺失项的错误，阻止带病启动 */
export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`环境变量校验失败 —— ${issues}`);
  }
  return parsed.data;
}
