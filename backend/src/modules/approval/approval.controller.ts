import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ApproveDto, CreateApprovalDto, ListApprovalsQueryDto, RejectDto } from './approval.dto';
import { ApprovalService } from './approval.service';

/** 审批队列端点（P1-05）。鉴权走全局守卫 + RequirePermission；
 * withdraw 额外在服务层校验「仅发起人本人」。 */
@Controller('approvals')
export class ApprovalController {
  constructor(private readonly approvals: ApprovalService) {}

  @Post()
  @RequirePermission('approval:request')
  create(@Body() body: CreateApprovalDto, @CurrentUser() actor: JwtPayload) {
    return this.approvals.create(actor, body);
  }

  @Get()
  @RequirePermission('approval:view')
  list(@Query() query: ListApprovalsQueryDto, @CurrentUser() actor: JwtPayload) {
    return this.approvals.list(actor, query.status);
  }

  @Post(':id/approve')
  @RequirePermission('approval:decide')
  approve(@Param('id') id: string, @Body() body: ApproveDto, @CurrentUser() actor: JwtPayload) {
    return this.approvals.approve(actor, id, body);
  }

  @Post(':id/reject')
  @RequirePermission('approval:decide')
  reject(@Param('id') id: string, @Body() body: RejectDto, @CurrentUser() actor: JwtPayload) {
    return this.approvals.reject(actor, id, body);
  }

  @Post(':id/withdraw')
  @RequirePermission('approval:request')
  withdraw(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.approvals.withdraw(actor, id);
  }
}
