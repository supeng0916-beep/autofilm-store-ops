import type { PipeTransform } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import {
  STAFF_RECORD_KIND_VALUES,
  TECHNICIAN_SKILL_VALUES,
  type TechnicianSkill,
} from '../team.constants';

/** 技师工种数组（v1.5 §5.4）：元素限工种枚举，至多 3 项（三工种全量上限） */
const technicianSkillsSchema = z.array(z.enum(TECHNICIAN_SKILL_VALUES)).max(3);

/** 新建技师（POST /team/technicians）：name 必填；skills 工种数组（v1.5 String[]），缺省=占位未填（落库 []） */
export class CreateTechnicianDto extends createZodDto(
  z.object({
    name: z.string().min(1, '姓名不能为空').max(50),
    skills: technicianSkillsSchema.optional(),
  }),
) {}

const updateTechnicianSchema = z.object({
  name: z.string().min(1, '姓名不能为空').max(50).optional(),
  skills: technicianSkillsSchema.nullable().optional(), // null=清空为 []
  active: z.boolean().optional(),
});

/** 更新技师（PATCH /team/technicians/:id）：全字段可选；skills 传 null 显式清空（落库 []）；active=false 停用（留痕不删） */
export class UpdateTechnicianDto extends createZodDto(updateTechnicianSchema) {}

/** PATCH 载荷载体：普通类（非 createZodDto）——全局 Zod 管道不识别则原样放行，
 * 由下方本路由管道接管校验，使非法工种枚举走 VALIDATION_FAILED → 422（同 search V2.3a 口径），
 * 而非全局管道统一的 400。字段与 updateTechnicianSchema 解析产物一致。 */
export class UpdateTechnicianBody {
  name?: string;
  skills?: TechnicianSkill[] | null;
  active?: boolean;
}

/** PATCH 本路由校验管道：schema 唯一来源仍为 updateTechnicianSchema，仅异常映射为 AppException(VALIDATION_FAILED) */
export class UpdateTechnicianPipe implements PipeTransform<unknown, UpdateTechnicianBody> {
  transform(value: unknown): UpdateTechnicianBody {
    const parsed = updateTechnicianSchema.safeParse(value);
    if (!parsed.success) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, '入参校验失败', parsed.error.issues);
    }
    return parsed.data;
  }
}

/** 录入人员记录（POST /team/records）：subjectType 固定 technician（V1 对象限技师，服务层落库）；
 * occurredAt 必填 ISO——补录口径，记录发生时间与录入时间分离；记录只增不改（留痕，无更新端点） */
export class CreateStaffRecordDto extends createZodDto(
  z.object({
    subjectId: z.string().min(1).max(64),
    kind: z.enum(STAFF_RECORD_KIND_VALUES),
    content: z.string().min(1, '内容不能为空').max(1000),
    occurredAt: z.string().datetime(),
  }),
) {}
