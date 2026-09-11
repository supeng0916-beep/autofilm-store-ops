import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** 创建内容台账（POST /marketing/content-records）：登记已发布内容。
 * contentKey 为归因键——与导入客资的 contentId 字段匹配（见 lead/import/row-schema.ts），
 * 复盘页据此归因，故必填且前后空格一律 trim（精确匹配口径）；唯一性由数据库约束兜底。
 * 金额一律分为单位；互动三项非负整数，缺省留空（后续回填）。 */
export class CreateContentRecordDto extends createZodDto(
  z.object({
    contentKey: z.string().trim().min(1).max(200),
    title: z.string().min(1).max(200),
    platform: z.string().max(50).optional(),
    publishedAt: z.coerce.date().optional(),
    costFen: z.coerce.number().int().nonnegative().default(0),
    viewsCount: z.coerce.number().int().nonnegative().optional(),
    likesCount: z.coerce.number().int().nonnegative().optional(),
    commentsCount: z.coerce.number().int().nonnegative().optional(),
    note: z.string().max(1000).optional(),
  }),
) {}

/** 更新内容台账（PATCH /marketing/content-records/:id）：仅互动数据/备注/成本可改——
 * 归因键 contentKey 与标题不可改（DTO 不接收，zod 剥离未知字段后至少一项校验兜底）。
 * 全可选 + 至少传一项（口径同 asset UpdateAssetDto）。 */
export class UpdateContentRecordDto extends createZodDto(
  z
    .object({
      viewsCount: z.coerce.number().int().nonnegative().optional(),
      likesCount: z.coerce.number().int().nonnegative().optional(),
      commentsCount: z.coerce.number().int().nonnegative().optional(),
      costFen: z.coerce.number().int().nonnegative().optional(),
      note: z.string().max(1000).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: '至少提供一个待更新字段' }),
) {}
