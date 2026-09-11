import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { CONFIRM_METHOD_VALUES } from '../appointment.states';
import { WO_STAGE_VALUES } from '../work-order.states';

/** 创建施工单（POST /work-orders）：从已确认预约快照生成（P5-04）。
 * technicianName：2026-08-28 bug3——预约未指定技师时，建单必须现场选定（服务层强校验，
 * 预约已有技师时以预约为准，本字段忽略），杜绝无技师施工单。 */
export class CreateWorkOrderDto extends createZodDto(
  z.object({
    appointmentId: z.string().min(1, '预约不能为空'),
    technicianName: z.string().min(1, '技师姓名不能为空').max(50).optional(),
    /** 技师 ID（批次3 T3）：优先落库；缺省由服务层按姓名反查回填 */
    technicianId: z.string().trim().max(64).optional(),
    /** 住宅膜勘测（批次3）：面积/朝向/玻璃材质/物业进场条件——仅 home_film 类型使用 */
    homeSurvey: z
      .object({
        glassArea: z.string().trim().max(50).optional(),
        orientation: z.string().trim().max(50).optional(),
        glassMaterial: z.string().trim().max(50).optional(),
        propertyCondition: z.string().trim().max(200).optional(),
      })
      .optional(),
  }),
) {}

/** 阶段推进公共入参：occurredAt 为受控补录的原时间（P5-04 SEC02：保留原时间与责任人） */
export class StageActionDto extends createZodDto(
  z.object({
    note: z.string().max(500).optional(),
    occurredAt: z.string().datetime({ offset: true }).optional(),
  }),
) {}

/** 返工（POST /work-orders/:id/rework）：原因必填（P5-05 可回溯） */
export class ReworkDto extends createZodDto(
  z.object({
    reason: z.string().min(1, '返工原因不能为空').max(500),
    note: z.string().max(500).optional(),
    occurredAt: z.string().datetime({ offset: true }).optional(),
  }),
) {}

/** 交付（POST /work-orders/:id/deliver）：可关联质保知识条目（P5-05） */
export class DeliverDto extends createZodDto(
  z.object({
    warrantyRef: z.string().max(200).optional(),
    note: z.string().max(500).optional(),
    occurredAt: z.string().datetime({ offset: true }).optional(),
  }),
) {}

/** 照片备注（multipart 文本字段；文件本体经 FileInterceptor 接收，P5-04） */
export class PhotoNoteDto extends createZodDto(
  z.object({
    note: z.string().max(200).optional(),
  }),
) {}

/** 异常记录（POST /work-orders/:id/abnormal） */
export class AddAbnormalDto extends createZodDto(
  z.object({
    description: z.string().min(1, '异常描述不能为空').max(500),
    occurredAt: z.string().datetime({ offset: true }).optional(),
  }),
) {}

/** 养护说明人工确认（POST /work-orders/:id/care-notes/confirm，P5-05） */
export class CareNotesConfirmDto extends createZodDto(
  z.object({
    content: z.string().min(1, '确认内容不能为空').max(5000),
  }),
) {}

/** 案例授权询问（POST /work-orders/:id/case-request，P5-06） */
export class CaseRequestDto extends createZodDto(
  z.object({
    authorized: z.boolean(),
    method: z.enum(CONFIRM_METHOD_VALUES).optional(),
    note: z.string().max(500).optional(),
  }),
) {}

/** 列表查询（GET /work-orders?stage=） */
export class ListWorkOrdersQueryDto extends createZodDto(
  z.object({
    stage: z.enum(WO_STAGE_VALUES).optional(),
  }),
) {}
