import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';

import type { JwtPayload } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/current-user.decorator';
import { RequirePermission } from '../../auth/require-permission.decorator';
import { CreateDraftDto, EditDraftDto, SendRecordDto } from '../lead.dto';
import { SalesDraftService } from './sales-draft.service';

/** sales.draft_message 草稿工作区端点（P3-06）：生成/改写/复制/记录发送/历史列表。
 * 全部 m03:edit + assertOwnerOrGlobal（sales_ops 仅本人客资，boss/store_manager 全局）。
 * 输出只落建议态（ai_tasks.output），对外动作一律不触发；「已复制」≠「已发送」。 */
@Controller('leads/:id/drafts')
export class SalesDraftController {
  constructor(private readonly drafts: SalesDraftService) {}

  @Post()
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  submit(@Param('id') id: string, @Body() body: CreateDraftDto, @CurrentUser() actor: JwtPayload) {
    return this.drafts.submitDraft(id, actor, body.goal);
  }

  @Patch(':taskId')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  edit(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() body: EditDraftDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.drafts.editDraft(id, taskId, actor, body.text);
  }

  @Post(':taskId/copy')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  copy(@Param('id') id: string, @Param('taskId') taskId: string, @CurrentUser() actor: JwtPayload) {
    return this.drafts.copyDraft(id, taskId, actor);
  }

  @Post(':taskId/send-record')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  sendRecord(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() body: SendRecordDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.drafts.recordSend(id, taskId, actor, body.sendEvidence);
  }

  @Get()
  @RequirePermission('m03:edit')
  list(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.drafts.listDrafts(id, actor);
  }
}
