import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** 手工创建回访（POST /aftercare/visits）：plan 固定 custom（服务端写死，见 visit.service），
 * 到期日必填。状态/计划取值唯一来源为 aftercare.states（VISIT_STATUS/VISIT_PLAN）。 */
export class CreateVisitDto extends createZodDto(
  z.object({
    workOrderId: z.string().min(1),
    dueAt: z.coerce.date(),
    note: z.string().max(500).optional(),
  }),
) {}

/** 列表查询（GET /aftercare/visits?status=）：按状态过滤，缺省全量（dueAt asc） */
export class ListVisitsQueryDto extends createZodDto(
  z.object({ status: z.enum(['pending', 'done', 'skipped']).optional() }),
) {}

/** execute/skip 动作体（POST /aftercare/visits/:id/execute|skip）：备注选填，覆盖原留痕备注 */
export class VisitActionDto extends createZodDto(
  z.object({ note: z.string().max(500).optional() }),
) {}
