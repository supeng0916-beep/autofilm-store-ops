import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Agent 对话入参（POST /agent/chat，2026-08-26 销售 Agent V1）：
 * history 入参上限 20、服务端 slice(-8) 截断为最近 8 轮（前端多轮拼接 + 兜底；400 拒收
 * 会把「多带历史」变成硬故障，与「截断兜底」设计意图相悖——2026-08-26 e2e 回归） */
export class AgentChatDto extends createZodDto(
  z.object({
    message: z.string().trim().min(1, '消息不能为空').max(2000, '消息不超过 2000 字'),
    history: z
      .array(
        z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(2000) }),
      )
      .max(20)
      .optional()
      .default([]),
  }),
) {}

/** persona 映射单条写入（PUT /agent/persona-map，V1.5）：persona=null 删除该条映射 */
export class PersonaMapEntryDto extends createZodDto(
  z.object({
    userId: z.string().min(1),
    persona: z.enum(['boss', 'manager', 'sales', 'general']).nullable(),
  }),
) {}

/** 陪练开局（V1.5 批次6a）：剧本值校验在服务层（含中文报错），此处只做形态校验 */
export class RoleplayStartDto extends createZodDto(
  z.object({
    scenario: z.string().trim().min(1),
    persona: z.record(z.string(), z.unknown()).optional(),
  }),
) {}

/** 陪练回合（批次6a）：员工发言 */
export class RoleplayTurnDto extends createZodDto(
  z.object({
    message: z.string().trim().min(1, '消息不能为空').max(2000),
  }),
) {}

/** 陪练结束（批次6a）：自评 1~5 可空 */
export class RoleplayFinishDto extends createZodDto(
  z.object({
    score: z.number().int().min(1).max(5).optional(),
  }),
) {}
