import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { APPROVAL_STATUS } from './approval.states';

/** 发起审批：type 为业务类型标识（quote_discount/content_publish/…），payload 为业务载荷 */
export class CreateApprovalDto extends createZodDto(
  z.object({
    type: z.string().min(1).max(64),
    payload: z.record(z.string(), z.unknown()),
    basis: z.string().max(500).optional(),
  }),
) {}

/** 列表查询：status 可选过滤（取值限定状态机四态） */
export class ListApprovalsQueryDto extends createZodDto(
  z.object({
    status: z
      .enum([
        APPROVAL_STATUS.PENDING,
        APPROVAL_STATUS.APPROVED,
        APPROVAL_STATUS.REJECTED,
        APPROVAL_STATUS.WITHDRAWN,
      ])
      .optional(),
  }),
) {}

/** 批准：confirmed 必须为字面量 true（二次确认双保险，缺省 → VALIDATION_FAILED） */
export class ApproveDto extends createZodDto(
  z.object({ confirmed: z.literal(true), opinion: z.string().max(500).optional() }),
) {}

/** 驳回：confirmed 必须为字面量 true；理由必填且 ≥5 字 */
export class RejectDto extends createZodDto(
  z.object({
    confirmed: z.literal(true),
    reason: z.string().min(5, '驳回必须填写理由（≥5字）').max(500),
  }),
) {}
