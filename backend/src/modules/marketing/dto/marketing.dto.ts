import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** 选题上下文（VideoCopyDto 内嵌）：从选题包带入选题时的结构化上下文，
 * 让脚本生成按选题的钩子方向与参考结构创作，而非只看一行主题 */
export const TopicContextSchema = z.object({
  angle: z.string().max(300).optional(),
  reason: z.string().max(300).optional(),
  hookDirection: z.string().max(300).optional(),
  structure: z.string().max(500).optional(),
  type: z.enum(['hot', 'evergreen']).optional(),
  source: z.string().max(200).optional(),
});

/** 短视频文案草稿（POST /marketing/video-copy） */
export class VideoCopyDto extends createZodDto(
  z.object({
    topic: z.string().min(2, '主题不能为空').max(200),
    productModel: z.string().max(50).optional(),
    carModel: z.string().max(50).optional(),
    style: z.enum(['专业可信', '轻松日常', '接地气']).optional(),
    durationSec: z.number().int().min(15).max(180).optional(),
    topicContext: TopicContextSchema.optional(),
  }),
) {}

/** 账号定位（PUT /marketing/video/positioning）：短视频账号的"身份证"，
 * 选题筛选与脚本生成都会注入；初始为按门店情况拟的默认草稿，老板改后落库 */
export class VideoPositioningDto extends createZodDto(
  z.object({
    storePositioning: z.string().min(10, '门店定位至少 10 字').max(300),
    targetAudience: z.string().min(5, '目标人群至少 5 字').max(300),
    persona: z.string().min(5, '账号人设至少 5 字').max(300),
    pillars: z.array(z.string().min(2).max(60)).min(1, '至少一个内容支柱').max(8),
    resources: z.string().max(300).optional().default(''),
    tone: z.string().max(200).optional().default(''),
  }),
) {}

/** 同行信息整理（POST /marketing/competitor-notes）——粘贴人工浏览的公开内容 */
export class CompetitorNotesDto extends createZodDto(
  z.object({
    sourceText: z.string().min(30, '原文至少 30 字（人工浏览公开内容后粘贴）').max(5000),
    sourcePlatform: z.string().max(50).optional(),
  }),
) {}
