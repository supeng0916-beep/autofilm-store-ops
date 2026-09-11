import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreateWarrantyDto, ListWarrantyQueryDto, WarrantyActionDto } from './dto/warranty.dto';
import { WarrantyService } from './warranty.service';

/** 质保登记端点（M09 批次1）：登记单列表/创建/登记动作。仅登记事实，不含理赔语义（任务书 §5.7）。
 * 权限点同回访/受理：m09:view/m09:edit（PERMISSION_MATRIX：boss/店长/销售，记录员无）。 */
@Controller('aftercare/warranty-registrations')
export class WarrantyController {
  constructor(private readonly svc: WarrantyService) {}

  /** 列表（GET /aftercare/warranty-registrations?status=）——createdAt desc，新登记在前 */
  @Get()
  @RequirePermission('m09:view')
  list(@Query() query: ListWarrantyQueryDto) {
    return this.svc.list(query);
  }

  /** 创建（POST /aftercare/warranty-registrations）——落库即 pending，载体字段均可选 */
  @Post()
  @RequirePermission('m09:edit')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateWarrantyDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.create(actor, dto);
  }

  /** 登记（POST /aftercare/warranty-registrations/:id/register）——仅 pending 可登记，重复 409 */
  @Post(':id/register')
  @RequirePermission('m09:edit')
  @HttpCode(HttpStatus.OK)
  register(
    @Param('id') id: string,
    @Body() dto: WarrantyActionDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.svc.register(actor, id, dto.note);
  }
}
