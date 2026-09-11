import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** 标签约束：trim 后非空、单个 ≤30 字（标签是短词：产品科普/施工过程/避坑…） */
const tagSchema = z.string().trim().min(1).max(30);

/** 创建灵感库条目（POST /marketing/video/inspirations）：爆款参考沉淀。
 * 拆解四要素中 rhythm 可空（节奏非每条都有），metrics 是文本描述
 * （「50w 赞/1.2w 评」非数值——量纲不齐，不拆列）；tags 对齐账号定位内容支柱，≤6 个。 */
export class CreateVideoInspirationDto extends createZodDto(
  z.object({
    platform: z.string().trim().min(1).max(50),
    title: z.string().trim().min(1).max(200),
    hookText: z.string().trim().min(1).max(2000),
    structure: z.string().trim().min(1).max(2000),
    rhythm: z.string().trim().max(2000).optional(),
    metrics: z.string().trim().max(200).optional(),
    tags: z.array(tagSchema).max(6, '标签最多 6 个').default([]),
    isPeer: z.boolean().default(false),
    sourceUrl: z.string().trim().max(500).optional(),
    note: z.string().max(1000).optional(),
  }),
) {}

/** 更新（PATCH /marketing/video/inspirations/:id）：仅 note/status/tags 可改——
 * 拆解内容（钩子/结构/节奏）是录入时的原文快照，改了就对不上原视频，一律重新登记；
 * status 仅 active/archived 二态（归档=不再注入 AI 上下文）。 */
export class UpdateVideoInspirationDto extends createZodDto(
  z
    .object({
      note: z.string().max(1000).optional(),
      status: z.enum(['active', 'archived']).optional(),
      tags: z.array(tagSchema).max(6, '标签最多 6 个').optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: '至少提供一个待更新字段' }),
) {}

/** 灵感拆解（POST /marketing/video/inspirations/dissect，批次B Task 2）：粘贴爆款
 * 原文（视频文案/描述/评论区数据）请 AI 拆解——建议态预览不直接入库，
 * 人工确认（可改）后走创建端点录入。原文长度口径沿 competitor-notes 的粘贴先例。 */
export class InspirationDissectDto extends createZodDto(
  z.object({
    rawText: z.string().trim().min(20, '原文至少 20 字（粘贴视频文案/描述/评论区数据）').max(5000),
    platform: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .optional()
      .transform((v) => (v ? v : undefined)),
    isPeer: z.boolean().optional(),
  }),
) {}

/** 列表过滤（GET /marketing/video/inspirations）：keyword 命中标题或钩子（浏览找参考），
 * platform 精确，isPeer 布尔，status 精确（不传=全部，active 优先候选次之归档沉底）。
 * query 均可空；isPeer 用字符串字面量二态解析——
 * z.coerce.boolean 会把 'false' 也判真，禁用。 */
export class ListVideoInspirationsQueryDto extends createZodDto(
  z.object({
    keyword: z
      .string()
      .trim()
      .max(100)
      .optional()
      .transform((v) => (v ? v : undefined)),
    platform: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .optional()
      .transform((v) => (v ? v : undefined)),
    isPeer: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
    status: z.enum(['active', 'archived', 'candidate']).optional(),
  }),
) {}
