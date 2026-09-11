import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { APPOINTMENT_STATUS_VALUES, CONFIRM_METHOD_VALUES } from '../appointment.states';
import { BUSINESS_TYPE_VALUES, normalizeWorkbench } from '../delivery.constants';

/** 创建预约（POST /appointments）——销售发起（m07:edit），落 pending 待店长审批。
 * 客资关联二选一（2026-08-25 老板反馈「客户 ID 没人知道怎么填」）：传 leadId 即可，
 * 服务端按客资联系方式查找或创建客户档案并回写 lead.customerId；customerId 保留为直连旧口径。 */
export class CreateAppointmentDto extends createZodDto(
  z
    .object({
      leadId: z.string().trim().min(1).optional(),
      customerId: z.string().trim().min(1).optional(),
      opportunityId: z.string().min(1).optional(),
      serviceItem: z.string().min(1, '服务项目不能为空').max(200),
      businessType: z.enum(BUSINESS_TYPE_VALUES),
      workbench: z
        .string()
        .min(1)
        .max(50)
        .transform((v) => normalizeWorkbench(v))
        .optional(),
      technicianName: z.string().min(1).max(50).optional(),
      technicianDesignated: z.boolean().optional().default(false),
      estHours: z.number().positive().max(100).optional(),
      startAt: z.string().datetime({ offset: true }), // 2026-08-27 #6：接受 ISO8601 时区偏移（+08:00），内部按 Date 归一 UTC
      endAt: z.string().datetime({ offset: true }),
      promise: z.string().max(500).optional(),
    })
    .superRefine((v, ctx) => {
      // 至少其一（2026-08-26 审查回归：互斥会误伤 leadId+customerId 并存的合法调用；
      // leadId 负责关联，customerId 缺省时由服务端按客资联系方式自动查找/建档）
      if (!v.leadId && !v.customerId) {
        ctx.addIssue({
          code: 'custom',
          message: '请关联客资（或直接填客户档案）',
          path: ['leadId'],
        });
      }
      if (new Date(v.endAt) <= new Date(v.startAt)) {
        ctx.addIssue({ code: 'custom', message: '结束时间必须晚于开始时间', path: ['endAt'] });
      }
      // 2026-08-28 UI 测试 #4：过去时间可建预约——补「开始不早于当前」校验
      // （留 5 分钟容忍客户端与服务端钟差/填表耗时，卡点即拒）。
      if (new Date(v.startAt).getTime() < Date.now() - 5 * 60 * 1000) {
        ctx.addIssue({ code: 'custom', message: '开始时间不能早于当前时间', path: ['startAt'] });
      }
    }),
) {}

/** 列表查询（GET /appointments?from=&to=&status=） */
export class ListAppointmentsQueryDto extends createZodDto(
  z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    status: z.enum(APPOINTMENT_STATUS_VALUES).optional(),
  }),
) {}

/** 冲突预检（GET /appointments/conflict-check）——提交前提醒可见 */
export class ConflictCheckQueryDto extends createZodDto(
  z
    .object({
      workbench: z
        .string()
        .min(1)
        .max(50)
        .transform((v) => normalizeWorkbench(v))
        .optional(),
      technicianName: z.string().min(1).max(50).optional(),
      startAt: z.string().datetime({ offset: true }), // 2026-08-27 #6：接受 ISO8601 时区偏移（+08:00），内部按 Date 归一 UTC
      endAt: z.string().datetime({ offset: true }),
    })
    .superRefine((v, ctx) => {
      if (new Date(v.endAt) <= new Date(v.startAt)) {
        ctx.addIssue({ code: 'custom', message: '结束时间必须晚于开始时间', path: ['endAt'] });
      }
    }),
) {}

/** 发起技师替换（POST /appointments/:id/technician-change）——需客户确认后生效 */
export class TechnicianChangeRequestDto extends createZodDto(
  z.object({
    toName: z.string().min(1, '新技师不能为空').max(50),
    reason: z.string().min(1, '替换原因不能为空').max(500),
  }),
) {}

/** 确认技师替换（POST /appointments/:id/technician-change/:changeId/confirm）——记录客户确认方式 */
export class TechnicianChangeConfirmDto extends createZodDto(
  z.object({
    confirmMethod: z.enum(CONFIRM_METHOD_VALUES),
    note: z.string().max(500).optional(),
  }),
) {}
