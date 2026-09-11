import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreateFinanceEntryDto, ListFinanceQueryDto } from './dto/finance.dto';
import { FinanceService } from './finance.service';

/** 财务收支流水端点（批次2 任务2，M10）：append-only——仅列表查询与登记，
 * 刻意不提供 PATCH/PUT/DELETE 路由（命中即 404），更正以补录新流水留痕。
 * 权限：读 m10:view（boss/store_manager/sales_ops 经 ALL_MODULE_VIEW），写 m10:edit（boss/store_manager）。 */
@Controller('finance/entries')
export class FinanceController {
  constructor(private readonly svc: FinanceService) {}

  /** 列表（GET /finance/entries?direction=&from=&to=）——occurredOn desc，新流水在前 */
  @Get()
  @RequirePermission('m10:view')
  list(@Query() query: ListFinanceQueryDto) {
    return this.svc.list(query);
  }

  /** 登记（POST /finance/entries）——金额分为单位、分类按 direction 联动校验（见 DTO） */
  @Post()
  @RequirePermission('m10:edit')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateFinanceEntryDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.create(actor, dto);
  }
}
