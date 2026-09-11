import { z } from 'zod';

/** 提交载荷（NestJS → OpenClaw，规格 §5.2）。zod 推导类型可被 skill 脚本复用。 */
export const SubmitTaskSchema = z.object({
  taskId: z.string().min(1),
  taskType: z.string().min(1),
  context: z.record(z.string(), z.unknown()),
  constraints: z.record(z.string(), z.unknown()),
  callbackUrl: z.url(),
  deadline: z.string().datetime(),
});
export type SubmitTaskRequest = z.infer<typeof SubmitTaskSchema>;

/** 回调用量上报 */
export const UsageSchema = z.object({
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
});

/** 回调信封（OpenClaw → NestJS）。output 的按 taskType 校验在注册表层做（此处只定信封）。 */
export const CallbackEnvelopeSchema = z.object({
  taskType: z.string().min(1),
  status: z.enum(['done', 'failed']),
  output: z.unknown().optional(),
  usage: UsageSchema.optional(),
  model: z.string().max(128).optional(),
  costEstimateFen: z.number().int().nonnegative().optional(),
  errorMessage: z.string().max(500).optional(),
});
export type CallbackEnvelope = z.infer<typeof CallbackEnvelopeSchema>;
