import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';

import type { JwtPayload } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/current-user.decorator';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { IntentConfirmDto } from '../lead.dto';
import { LeadClassifyService } from './lead-classify.service';

/** lead.classify 意向分级端点（P3-07）：手工触发分级 / 待确认建议 / 人工确认与改判。
 * GET 走 m03:view，写动作（classify/intent-confirm）走 m03:edit＋assertOwnerOrGlobal（服务层）。
 * 分级建议只落 ai_tasks.output；确认才写 intentLevel/intentEvidence/intentConfirmedBy。 */
@Controller('leads/:id')
export class LeadClassifyController {
  constructor(private readonly classify: LeadClassifyService) {}

  @Post('classify')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  submit(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.classify.submitClassify(id, actor);
  }

  @Get('intent-proposals')
  @RequirePermission('m03:view')
  proposals(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.classify.getProposals(id, actor);
  }

  @Post('intent-confirm')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  confirm(
    @Param('id') id: string,
    @Body() body: IntentConfirmDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.classify.confirm(id, actor, {
      taskId: body.taskId,
      level: body.level,
      reason: body.reason,
    });
  }
}
