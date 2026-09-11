import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { AppointmentService } from './appointment.service';
import {
  ConflictCheckQueryDto,
  CreateAppointmentDto,
  ListAppointmentsQueryDto,
  TechnicianChangeConfirmDto,
  TechnicianChangeRequestDto,
} from './dto/appointment.dto';

/** 预约端点（M07，P5-01~03）：发起预约（m07:edit，销售）→ 店长审批确认（审批中心）。
 * 冲突检测在创建与预检两处可见；技师替换需客户确认记录后生效。 */
@Controller('appointments')
export class AppointmentController {
  constructor(private readonly svc: AppointmentService) {}

  /** 创建预约（POST /appointments） */
  @Post()
  @RequirePermission('m07:edit')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateAppointmentDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.create(actor, dto);
  }

  /** 列表（GET /appointments?from=&to=&status=） */
  @Get()
  @RequirePermission('m07:view')
  list(@Query() query: ListAppointmentsQueryDto) {
    return this.svc.list(query);
  }

  /** 冲突预检（GET /appointments/conflict-check）——须置于 :id 路由之前 */
  @Get('conflict-check')
  @RequirePermission('m07:view')
  conflictCheck(@Query() query: ConflictCheckQueryDto) {
    return this.svc.checkConflicts(query);
  }

  /** 详情（GET /appointments/:id） */
  @Get(':id')
  @RequirePermission('m07:view')
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  /** 取消（POST /appointments/:id/cancel） */
  @Post(':id/cancel')
  @RequirePermission('m07:edit')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.svc.cancel(actor, id);
  }

  /** 发起技师替换（POST /appointments/:id/technician-change） */
  @Post(':id/technician-change')
  @RequirePermission('m07:edit')
  @HttpCode(HttpStatus.CREATED)
  requestTechnicianChange(
    @Param('id') id: string,
    @Body() dto: TechnicianChangeRequestDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.svc.requestTechnicianChange(actor, id, dto);
  }

  /** 替换记录列表（GET /appointments/:id/technician-changes） */
  @Get(':id/technician-changes')
  @RequirePermission('m07:view')
  listTechnicianChanges(@Param('id') id: string) {
    return this.svc.listTechnicianChanges(id);
  }

  /** 客户确认替换（POST /appointments/:id/technician-change/:changeId/confirm） */
  @Post(':id/technician-change/:changeId/confirm')
  @RequirePermission('m07:edit')
  @HttpCode(HttpStatus.OK)
  confirmTechnicianChange(
    @Param('id') id: string,
    @Param('changeId') changeId: string,
    @Body() dto: TechnicianChangeConfirmDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.svc.confirmTechnicianChange(actor, id, changeId, dto);
  }
}
