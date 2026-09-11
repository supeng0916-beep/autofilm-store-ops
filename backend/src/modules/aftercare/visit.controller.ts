import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreateVisitDto, ListVisitsQueryDto, VisitActionDto } from './dto/aftercare.dto';
import { VisitService } from './visit.service';

/** 回访端点（M09 批次1）：列表按状态过滤；手工创建固定 custom；执行/跳过走条件状态迁移。
 * 权限点沿用 m09:view/m09:edit（PERMISSION_MATRIX：boss/店长/销售均有回访执行权，记录员无）。 */
@Controller('aftercare/visits')
export class VisitController {
  constructor(private readonly svc: VisitService) {}

  /** 列表（GET /aftercare/visits?status=）——dueAt asc，先到期先处理 */
  @Get()
  @RequirePermission('m09:view')
  list(@Query() query: ListVisitsQueryDto) {
    return this.svc.list(query);
  }

  /** 手工创建（POST /aftercare/visits） */
  @Post()
  @RequirePermission('m09:edit')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateVisitDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.create(actor, dto);
  }

  /** 执行（POST /aftercare/visits/:id/execute）——仅 pending 可执行，重复 409 */
  @Post(':id/execute')
  @RequirePermission('m09:edit')
  @HttpCode(HttpStatus.OK)
  execute(@Param('id') id: string, @Body() dto: VisitActionDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.execute(actor, id, dto.note);
  }

  /** 跳过（POST /aftercare/visits/:id/skip）——仅 pending 可跳过，重复 409 */
  @Post(':id/skip')
  @RequirePermission('m09:edit')
  @HttpCode(HttpStatus.OK)
  skip(@Param('id') id: string, @Body() dto: VisitActionDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.skip(actor, id, dto.note);
  }
}
