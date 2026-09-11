import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreateReferralDto, ListReferralsQueryDto, ReferralActionDto } from './dto/referral.dto';
import { ReferralService } from './referral.service';

/** 转介绍端点（M09 批次1）：老客带新登记列表/创建/标成交；同客资唯一约束 409。
 * 权限点同回访/受理：m09:view/m09:edit（PERMISSION_MATRIX：boss/店长/销售，记录员无）。 */
@Controller('aftercare/referrals')
export class ReferralController {
  constructor(private readonly svc: ReferralService) {}

  /** 列表（GET /aftercare/referrals?status=）——createdAt desc，新登记在前 */
  @Get()
  @RequirePermission('m09:view')
  list(@Query() query: ListReferralsQueryDto) {
    return this.svc.list(query);
  }

  /** 创建（POST /aftercare/referrals）——同一 referredLeadId 重复登记 409 */
  @Post()
  @RequirePermission('m09:edit')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateReferralDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.create(actor, dto);
  }

  /** 标成交（POST /aftercare/referrals/:id/mark-won）——仅 pending 可标，重复 409 */
  @Post(':id/mark-won')
  @RequirePermission('m09:edit')
  @HttpCode(HttpStatus.OK)
  markWon(
    @Param('id') id: string,
    @Body() dto: ReferralActionDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.svc.markWon(actor, id, dto.note);
  }
}
