import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreateOrderConfirmationDto, ListOrderConfirmationsQueryDto } from './dto/order.dto';
import { OrderConfirmationService } from './order-confirmation.service';

/** 订单确认单端点（批次1 Task 7）：创建/列表/客户确认；同客资唯一约束 409。
 * 权限复用客资成交链权限点：读 m03:view、写 m03:edit（不新增权限点）。
 * 可选步骤：本端点不与施工单/预约产生任何闸门关系（老板已拍板 2026-09-01）。 */
@Controller('order-confirmations')
export class OrderConfirmationController {
  constructor(private readonly svc: OrderConfirmationService) {}

  /** 欠款提醒（批次5 Task 5）：confirmed 且尾款>0 的清单（财务页面板数据源）。
   * 路由顺序：字面量路由必须先于参数路由——本控制器暂无 GET ':id' 路由（':id/confirm'
   * 是 POST 不冲突），仍将 /arrears 声明在全部 GET 之前，防后续新增 GET ':id' 时被吞。 */
  @Get('arrears')
  @RequirePermission('m03:view')
  arrears() {
    return this.svc.arrears();
  }

  /** 列表（GET /order-confirmations?leadId=）——createdAt desc，新单在前 */
  @Get()
  @RequirePermission('m03:view')
  list(@Query() query: ListOrderConfirmationsQueryDto) {
    return this.svc.list(query);
  }

  /** 创建（POST /order-confirmations）——客资须已成交；重复创建 409 */
  @Post()
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateOrderConfirmationDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.create(actor, dto);
  }

  /** 客户确认（POST /order-confirmations/:id/confirm）——仅 draft 可确认，重复 409 */
  @Post(':id/confirm')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  confirm(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.svc.confirm(actor, id);
  }
}
