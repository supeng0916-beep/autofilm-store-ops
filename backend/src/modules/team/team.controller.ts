import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import {
  CreateStaffRecordDto,
  CreateTechnicianDto,
  UpdateTechnicianBody,
  UpdateTechnicianPipe,
} from './dto/team.dto';
import { TeamService } from './team.service';

/** 人机团队端点（M08，V2.4）。查看聚合：m08:view（老板/店长/销售/记录员）；
 * 写操作（建档/改名/停用/录入）不走权限点——技师为资源实体，写权限由服务层
 * 角色硬校验 boss|store_manager（403 PERM_DENIED；boss/store_manager 均无 m08:edit，
 * 不能用权限点表达该集合，故端点只要求认证）。 */
@Controller('team')
export class TeamController {
  constructor(private readonly svc: TeamService) {}

  /** 总览（GET /team/overview）：技师卡（档案+忙闲+指标）+ Agent 花名册 + 近期记录 */
  @Get('overview')
  @RequirePermission('m08:view')
  overview() {
    return this.svc.overview();
  }

  /** 新建技师（POST /team/technicians） */
  @Post('technicians')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateTechnicianDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.createTechnician(actor, dto);
  }

  /** 更新技师（PATCH /team/technicians/:id）：改名/专长/停用；
   * body 走本路由管道：非法工种枚举 → VALIDATION_FAILED 422（同 search V2.3a 口径） */
  @Patch('technicians/:id')
  update(
    @Param('id') id: string,
    @Body(new UpdateTechnicianPipe()) dto: UpdateTechnicianBody,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.svc.updateTechnician(actor, id, dto);
  }

  /** 录入人员记录（POST /team/records）：考勤/奖惩/备注，只增不改 */
  @Post('records')
  @HttpCode(HttpStatus.CREATED)
  createRecord(@Body() dto: CreateStaffRecordDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.createRecord(actor, dto);
  }
}
