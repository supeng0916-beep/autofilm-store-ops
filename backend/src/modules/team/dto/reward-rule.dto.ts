import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { REWARD_COMPARATORS, REWARD_DIRECTIONS, REWARD_METRICS } from '../reward-rule.constants';

/** 规则创建（批次3）：metric×comparator×threshold×direction×amountFen */
export class CreateRewardRuleDto extends createZodDto(
  z.object({
    name: z.string().trim().min(1).max(100),
    metric: z.enum(REWARD_METRICS),
    comparator: z.enum(REWARD_COMPARATORS),
    threshold: z.number().int().nonnegative(),
    direction: z.enum(REWARD_DIRECTIONS),
    amountFen: z.number().int().positive(),
  }),
) {}

/** 规则启停/编辑（至少一项） */
export class UpdateRewardRuleDto extends createZodDto(
  z
    .object({
      name: z.string().trim().min(1).max(100).optional(),
      threshold: z.number().int().nonnegative().optional(),
      amountFen: z.number().int().positive().optional(),
      enabled: z.boolean().optional(),
    })
    .refine((r) => Object.values(r).some((v) => v !== undefined), { message: '至少修改一项' }),
) {}

/** 月度草案确认（批次3）：人拍板落 StaffRecord */
export class ConfirmRewardsDto extends createZodDto(
  z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/, '月份格式 YYYY-MM'),
    items: z
      .array(
        z.object({
          ruleId: z.string().min(1),
          technicianName: z.string().trim().min(1).max(50),
          metricValue: z.number().int(),
          amountFen: z.number().int().positive(),
          direction: z.enum(REWARD_DIRECTIONS),
          note: z.string().max(200).optional(),
        }),
      )
      .min(1)
      .max(50),
  }),
) {}
