import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { SR_KIND_VALUES, SR_STATUS } from '../aftercare.states';

/** 创建售后受理（POST /aftercare/service-requests）：四类受理（咨询/复检/投诉/其他），
 * 载体（客户/客资/施工单）均可选——受理可先登记后补关联。
 * 取值唯一来源为 aftercare.states（SR_KIND）。 */
export class CreateServiceRequestDto extends createZodDto(
  z.object({
    kind: z.enum(SR_KIND_VALUES),
    content: z.string().min(1).max(2000),
    customerId: z.string().optional(),
    leadId: z.string().optional(),
    workOrderId: z.string().optional(),
  }),
) {}

/** 列表查询（GET /aftercare/service-requests?status=&kind=）：双维过滤，缺省全量（createdAt desc） */
export class ListServiceRequestsQueryDto extends createZodDto(
  z.object({
    status: z.enum([SR_STATUS.OPEN, SR_STATUS.IN_PROGRESS, SR_STATUS.RESOLVED]).optional(),
    kind: z.enum(SR_KIND_VALUES).optional(),
  }),
) {}

/** 推进受理（PATCH /aftercare/service-requests/:id）：领单（in_progress+处理人）/
 * 解决（resolved+结果）单向迁移，三个字段至少一项（空 PATCH 拒绝） */
export class UpdateServiceRequestDto extends createZodDto(
  z
    .object({
      status: z.enum([SR_STATUS.IN_PROGRESS, SR_STATUS.RESOLVED]).optional(),
      handlerUserId: z.string().optional(),
      result: z.string().max(2000).optional(),
    })
    .refine(
      (v) => v.status !== undefined || v.handlerUserId !== undefined || v.result !== undefined,
      { message: '至少提供一个待更新字段' },
    ),
) {}
