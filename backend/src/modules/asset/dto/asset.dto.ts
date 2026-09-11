import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { ASSET_KIND_VALUES } from '../asset.constants';

/** 上传素材（POST /assets，multipart）：元数据随文本字段，文件本体经 FileInterceptor 接收。
 * licensed 经 multipart 以字符串到达，stringbool 兼容 "true"/"false"（V2.3b） */
export class UploadAssetDto extends createZodDto(
  z.object({
    kind: z.enum(ASSET_KIND_VALUES),
    title: z.string().min(1, '标题不能为空').max(200),
    carModel: z.string().max(100).optional(),
    productModel: z.string().max(100).optional(),
    stage: z.string().max(50).optional(),
    technicianName: z.string().max(50).optional(),
    source: z.string().max(200).optional(),
    licensed: z.stringbool().optional().default(false),
    workOrderId: z.string().max(64).optional(),
  }),
) {}

/** 列表查询（GET /assets?kind=&keyword=）：keyword 匹配 title/carModel（ILIKE） */
export class ListAssetsQueryDto extends createZodDto(
  z.object({
    kind: z.enum(ASSET_KIND_VALUES).optional(),
    keyword: z.string().min(1).max(100).optional(),
  }),
) {}

/** 素材编辑（PATCH /assets/:id，v1.5 T11）：仅传字段被更新，未传字段不动。
 * tags 为已确认标签（AI 建议标签经人工确认后写入，T13） */
export class UpdateAssetDto extends createZodDto(
  z
    .object({
      // 标签上限 ≤8 个/单项 ≤30 字（2026-09-01 快修批次 Task2 统一口径）：
      // 与前端 AssetsView.vue TAG_MAX_COUNT=8/TAG_MAX_LEN=30 及 AI suggest 输出口径一致
      tags: z.array(z.string().trim().min(1).max(30)).max(8).optional(),
      licensed: z.boolean().optional(),
      title: z.string().min(1).max(200).optional(),
      carModel: z.string().max(100).optional(),
      productModel: z.string().max(100).optional(),
      stage: z.string().max(50).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: '至少提供一个待更新字段' }),
) {}

/** 批量上传元数据（POST /assets/batch，v1.5 T11）：kind 必填；
 * title 可选留档，单条素材 title 一律取原文件名去扩展名（更直观）；
 * carModel 可选（2026-08-28）：应用于本批全部文件——网页批量上传也能按车型分组 */
export class BatchUploadMetaDto extends createZodDto(
  z.object({
    kind: z.enum(ASSET_KIND_VALUES),
    title: z.string().min(1).max(200).optional(),
    carModel: z.string().min(1).max(100).optional(),
  }),
) {}

/** 批量授权（PATCH /assets/batch，2026-08-25 老板反馈）：一键将所选素材标记授权/内部。
 * 上限 200 与批量上传单批口径一致。 */
export class BatchLicensedDto extends createZodDto(
  z.object({
    ids: z.array(z.string().min(1)).min(1, '至少选择一个素材').max(200, '单批最多 200 个'),
    licensed: z.boolean(),
  }),
) {}
