import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { KnowledgeSearchService } from './knowledge-search.service';

/** 知识检索请求 */
export class SearchKnowledgeDto extends createZodDto(
  z.object({
    query: z.string().min(1, '查询内容不能为空').max(500),
  }),
) {}

/** 知识检索端点（P4-03）：POST /knowledge/search */
@Controller('knowledge')
export class KnowledgeSearchController {
  constructor(private readonly svc: KnowledgeSearchService) {}

  @Post('search')
  @RequirePermission('m06:view')
  @HttpCode(HttpStatus.OK)
  search(@Body() dto: SearchKnowledgeDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.search(actor, dto);
  }
}
