import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  EXPENSE_CATEGORY_VALUES,
  FINANCE_DIRECTION,
  INCOME_CATEGORY_VALUES,
} from '../finance.constants';

/** 创建流水（POST /finance/entries）——append-only 只增不改：仅有创建与列表端点。
 * 分类与 direction 联动：superRefine 按方向查对应枚举表（收入→INCOME_CATEGORY、
 * 支出→EXPENSE_CATEGORY），枚举唯一来源 finance.constants.ts（批次2 任务1）。
 * 金额一律分为单位，0/负数/小数一律拒绝。 */
export class CreateFinanceEntryDto extends createZodDto(
  z
    .object({
      direction: z.enum([FINANCE_DIRECTION.INCOME, FINANCE_DIRECTION.EXPENSE]),
      category: z.string().min(1).max(50),
      amountFen: z.coerce.number().int().positive(),
      occurredOn: z.coerce.date(),
      remark: z.string().max(500).optional(),
      leadId: z.string().max(64).optional(),
      orderConfirmationId: z.string().max(64).optional(),
    })
    .superRefine((v, ctx) => {
      const allowed =
        v.direction === FINANCE_DIRECTION.INCOME ? INCOME_CATEGORY_VALUES : EXPENSE_CATEGORY_VALUES;
      if (!allowed.includes(v.category)) {
        ctx.addIssue({
          code: 'custom',
          message: `分类须为${v.direction === FINANCE_DIRECTION.INCOME ? '收入' : '支出'}类目`,
          path: ['category'],
        });
      }
    }),
) {}

/** 列表查询（GET /finance/entries?direction=&from=&to=）：全部可选；
 * from/to 为 ISO 日期时间字符串，作用于 occurredOn 闭区间（gte/lte，同预约列表口径）。 */
export class ListFinanceQueryDto extends createZodDto(
  z.object({
    direction: z.enum([FINANCE_DIRECTION.INCOME, FINANCE_DIRECTION.EXPENSE]).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }),
) {}
