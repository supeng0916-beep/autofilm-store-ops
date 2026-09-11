import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { PAY_METHOD_VALUES } from '../order.states';

/** 创建订单确认单（POST /order-confirmations）：只能挂已成交客资（服务层前置校验）。
 * 金额一律分为单位（depositFen/balanceFen），报价快照原文保留（报价图/报价单文字摘要）。
 * 批次1 Task 7：可选步骤，不作施工单闸门（老板已拍板 2026-09-01）。 */
export class CreateOrderConfirmationDto extends createZodDto(
  z.object({
    leadId: z.string().min(1),
    products: z.string().min(1).max(1000),
    quoteSnapshot: z.string().min(1).max(2000),
    discountNote: z.string().max(1000).optional(),
    depositFen: z.coerce.number().int().nonnegative().default(0),
    balanceFen: z.coerce.number().int().nonnegative().default(0),
    /** 材料成本（分，批次4 毛利估算）：选填，缺省不传即"未录成本"（复盘毛利口径不计入） */
    materialCostFen: z.coerce.number().int().nonnegative().optional(),
    payMethod: z.enum(PAY_METHOD_VALUES).optional(),
    appointmentId: z.string().optional(),
  }),
) {}

/** 列表查询（GET /order-confirmations?leadId=）：按客资过滤，缺省全量（createdAt desc） */
export class ListOrderConfirmationsQueryDto extends createZodDto(
  z.object({
    leadId: z.string().optional(),
  }),
) {}
