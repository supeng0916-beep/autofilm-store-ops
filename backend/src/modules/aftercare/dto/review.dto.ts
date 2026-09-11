import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** 创建客户评价（POST /aftercare/reviews，缺口补齐批次 Task 2，append-only）：
 * score 1-5 必填（coerce 兼容表单字符串）；三个载体 ID（客户/客资/施工单）均可选，
 * 评语选填上限 1000 字。创建后不可改不可删（无 PATCH/DELETE 端点）。 */
export class CreateReviewDto extends createZodDto(
  z.object({
    customerId: z.string().optional(),
    leadId: z.string().optional(),
    workOrderId: z.string().optional(),
    score: z.coerce.number().int().min(1).max(5),
    content: z.string().max(1000).optional(),
  }),
) {}
