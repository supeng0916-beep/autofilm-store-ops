import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** 同行动态人工录入（批次4） */
export class CreateCompetitorPostDto extends createZodDto(
  z.object({
    account: z.string().trim().min(1, '同行账号必填').max(100),
    title: z.string().trim().min(1, '标题必填').max(300),
    publishedAt: z.coerce.date().optional(),
    likesCount: z.coerce.number().int().nonnegative().optional(),
    commentsCount: z.coerce.number().int().nonnegative().optional(),
    sharesCount: z.coerce.number().int().nonnegative().optional(),
    activityType: z.string().trim().max(50).optional(),
    note: z.string().max(500).optional(),
  }),
) {}

/** 爬虫批量 upsert（批次4）：items ≤100/批 */
export class CrawlerUpsertDto extends createZodDto(
  z.object({
    items: z
      .array(
        z.object({
          account: z.string().trim().min(1).max(100),
          title: z.string().trim().min(1).max(300),
          publishedAt: z.string().datetime().optional(),
          likesCount: z.coerce.number().int().nonnegative().optional(),
          commentsCount: z.coerce.number().int().nonnegative().optional(),
          sharesCount: z.coerce.number().int().nonnegative().optional(),
        }),
      )
      .min(1)
      .max(100),
  }),
) {}
