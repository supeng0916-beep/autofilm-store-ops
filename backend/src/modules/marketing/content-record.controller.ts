import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ContentRecordService } from './content-record.service';
import { CreateContentRecordDto, UpdateContentRecordDto } from './dto/content-record.dto';

/** 内容台账端点（批次2 任务3，M02）：登记已发布内容（归因键）与互动数据回填。
 * 权限口径与既有营销写端点一致：写 = m02:edit ∪ m02:approve（任一），读 = m02:view；
 * recorder 无任何 m02 权限 → 一律 403。刻意不提供 DELETE（台账供复盘归因，只增与改）。 */
@Controller('marketing/content-records')
export class ContentRecordController {
  constructor(private readonly svc: ContentRecordService) {}

  /** 列表（GET /marketing/content-records）——publishedAt desc，未登记发布日期的排最后 */
  @Get()
  @RequirePermission('m02:view')
  list() {
    return this.svc.list();
  }

  /** 登记（POST /marketing/content-records）——contentKey 归因键唯一，撞键 409 */
  @Post()
  @RequirePermission('m02:edit', 'm02:approve')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateContentRecordDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.create(actor, dto);
  }

  /** 回填（PATCH /marketing/content-records/:id）——仅互动数据/备注/成本可改 */
  @Patch(':id')
  @RequirePermission('m02:edit', 'm02:approve')
  @HttpCode(HttpStatus.OK)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateContentRecordDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.svc.update(actor, id, dto);
  }
}
