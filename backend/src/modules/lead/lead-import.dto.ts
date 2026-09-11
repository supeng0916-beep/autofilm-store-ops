import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** 确认导入：凭预览 token 取回暂存行并落库（token 由 preview 下发，10 分钟 TTL） */
export class ConfirmImportDto extends createZodDto(
  z.object({ previewToken: z.string().min(1, '缺少预览令牌') }),
) {}

/** 派发文本导入：逐条原文（1–50 条） */
export class DispatchImportDto extends createZodDto(
  z.object({
    rawTexts: z
      .array(z.string().min(1, '派发文本不能为空'))
      .min(1, '至少一条派发文本')
      .max(50, '一次最多 50 条'),
  }),
) {}

/** 人工合并：targetLeadId（次要）并入 URL 中的 :id（主要） */
export class MergeLeadsDto extends createZodDto(
  z.object({ targetLeadId: z.string().min(1, '缺少并入客资ID') }),
) {}
