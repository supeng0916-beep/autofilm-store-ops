import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { REFERRAL_STATUS } from '../aftercare.states';

/** 创建转介绍登记（POST /aftercare/referrals）：介绍人客户必填；
 * 被转介绍客体至少一项（客资 referredLeadId / 客户 referredCustomerId）——
 * 先登记客资、成交后补客户档案的场景两者可并存。 */
export class CreateReferralDto extends createZodDto(
  z
    .object({
      referrerCustomerId: z.string().min(1),
      referredLeadId: z.string().optional(),
      referredCustomerId: z.string().optional(),
      note: z.string().max(500).optional(),
    })
    .refine((v) => v.referredLeadId !== undefined || v.referredCustomerId !== undefined, {
      message: 'referredLeadId/referredCustomerId 至少提供一项',
    }),
) {}

/** 列表查询（GET /aftercare/referrals?status=）：按状态过滤，缺省全量（createdAt desc） */
export class ListReferralsQueryDto extends createZodDto(
  z.object({
    status: z.enum([REFERRAL_STATUS.PENDING, REFERRAL_STATUS.WON]).optional(),
  }),
) {}

/** mark-won 动作体（POST /aftercare/referrals/:id/mark-won）：备注选填，覆盖原留痕备注 */
export class ReferralActionDto extends createZodDto(
  z.object({ note: z.string().max(500).optional() }),
) {}
