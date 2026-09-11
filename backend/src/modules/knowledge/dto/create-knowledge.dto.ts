import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { KNOWLEDGE_KIND_VALUES } from '../knowledge.constants';
import { KNOWLEDGE_STATUS_VALUES } from '../knowledge.states';

/** 创建知识条目（POST /knowledge） */
export class CreateKnowledgeDto extends createZodDto(
  z.object({
    kind: z.enum(KNOWLEDGE_KIND_VALUES),
    key: z
      .string()
      .min(1, '业务键不能为空')
      .max(64)
      .regex(/^[a-z0-9_-]+$/, '业务键仅允许小写字母、数字、下划线和连字符'),
    title: z.string().min(1, '标题不能为空').max(200),
    content: z.string().min(1, '内容不能为空').max(10000),
    source: z.string().max(500).optional(),
    licensed: z.boolean().optional().default(false),
    expiresAt: z.string().datetime().optional(),
    tags: z.record(z.string(), z.unknown()).optional(),
  }),
) {}

/** 编辑知识条目（PATCH /knowledge/:id）——生成新版本 */
export class UpdateKnowledgeDto extends createZodDto(
  z.object({
    title: z.string().min(1).max(200).optional(),
    content: z.string().min(1).max(10000).optional(),
    source: z.string().max(500).optional(),
    licensed: z.boolean().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    tags: z.record(z.string(), z.unknown()).optional(),
  }),
) {}

/** 知识库列表查询（GET /knowledge） */
export class ListKnowledgeQueryDto extends createZodDto(
  z.object({
    kind: z.enum(KNOWLEDGE_KIND_VALUES).optional(),
    status: z.enum(KNOWLEDGE_STATUS_VALUES).optional(),
    keyword: z.string().min(1).max(100).optional(),
  }),
) {}

/** 知识源文件读取（GET /knowledge/source-file?path=，#14）：path 须为 `门店知识源/` 前缀的 .md；
 * 目录白名单/防路径穿越校验在服务层（resolve 后必须仍在 门店知识源/ 内） */
export class SourceFileQueryDto extends createZodDto(
  z.object({
    path: z.string().min(1, 'path 不能为空').max(500),
  }),
) {}
