import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreateReviewDto } from './dto/review.dto';
import { ReviewService } from './review.service';

/** 客户评价端点（M09 缺口补齐批次 Task 2）：交付后评分与评语登记，
 * append-only——仅列表/创建，无 PATCH/DELETE 路由（改动诉求走审计口径另起）。
 * 权限点同回访/受理/质保/转介绍：m09:view/m09:edit（PERMISSION_MATRIX：boss/店长/销售，记录员无）。 */
@Controller('aftercare/reviews')
export class ReviewController {
  constructor(private readonly svc: ReviewService) {}

  /** 列表（GET /aftercare/reviews）——reviewedAt desc，新评价在前 */
  @Get()
  @RequirePermission('m09:view')
  list() {
    return this.svc.list();
  }

  /** 创建（POST /aftercare/reviews）——score 1-5，三个载体 ID 均可选 */
  @Post()
  @RequirePermission('m09:edit')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateReviewDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.create(actor, dto);
  }
}
