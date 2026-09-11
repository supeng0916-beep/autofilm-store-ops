import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { WARRANTY_STATUS } from '../aftercare.states';

/** 创建质保登记（POST /aftercare/warranty-registrations）：载体（施工单/客户）与
 * 产品信息、登记编号、登记时间均可选——允许先登记占位后补全（同受理口径）。
 * 红线（任务书 §5.7）：仅登记事实字段，不承载任何理赔承诺语义。 */
export class CreateWarrantyDto extends createZodDto(
  z.object({
    workOrderId: z.string().optional(),
    customerId: z.string().optional(),
    productModel: z.string().max(200).optional(),
    registrationNo: z.string().max(200).optional(),
    registeredAt: z.coerce.date().optional(),
    note: z.string().max(500).optional(),
  }),
) {}

/** 列表查询（GET /aftercare/warranty-registrations?status=）：按状态过滤，缺省全量（createdAt desc） */
export class ListWarrantyQueryDto extends createZodDto(
  z.object({
    status: z.enum([WARRANTY_STATUS.PENDING, WARRANTY_STATUS.REGISTERED]).optional(),
  }),
) {}

/** register 动作体（POST /aftercare/warranty-registrations/:id/register）：备注选填，覆盖原留痕备注 */
export class WarrantyActionDto extends createZodDto(
  z.object({ note: z.string().max(500).optional() }),
) {}
