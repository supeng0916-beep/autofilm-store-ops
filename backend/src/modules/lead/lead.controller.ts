import { UpdateLeadProfileDto } from './lead.dto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { LeadSummaryService } from './ai/lead-summary.service';
import { AssignService } from './assign.service';
import {
  AiSummaryFeedbackDto,
  AssignLeadDto,
  DupCheckQueryDto,
  ListLeadsQueryDto,
  ManualRegisterDto,
  MarkInvalidDto,
  MarkWonDto,
  PauseLeadDto,
  ProposeChurnDto,
  RecordFollowUpDto,
  ReopenLeadDto,
  TakeoverLeadDto,
  TransitionStageDto,
} from './lead.dto';
import { LeadLifecycleService } from './lead-lifecycle.service';
import { LeadManualService } from './lead-manual.service';
import { LeadService } from './lead.service';

/** 客资队列/详情/分配/认领/生命周期端点（P3-03/P3-04）。
 * 鉴权走全局守卫 + @RequirePermission；数据范围与 chatLink 脱敏在服务层强制；
 * 生命周期写动作（stage/churn/reopen/won/invalid/follow-up/pause/resume/takeover）走 LeadLifecycleService。 */
@Controller('leads')
export class LeadController {
  constructor(
    private readonly leads: LeadService,
    private readonly assignSvc: AssignService,
    private readonly lifecycle: LeadLifecycleService,
    private readonly summary: LeadSummaryService,
    private readonly manual: LeadManualService,
  ) {}

  /** 手工登记（POST /leads，2026-08-25 老板需求）：字段=字典 17 列导入子集；
   * 负责人可选指定（默认分派池自动路由），登记后与导入客资同权进入 SLA/跟进流程 */
  @Post()
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: ManualRegisterDto, @CurrentUser() actor: JwtPayload) {
    return this.manual.register(actor, dto);
  }

  /** 可指定负责人（GET /leads/assignable-users）：在职 boss/店长/销售（登记表单下拉）；
   * 字面量路由须先于 @Get(':id') */
  @Get('assignable-users')
  @RequirePermission('m03:edit')
  assignableUsers() {
    return this.manual.assignableUsers();
  }

  /** 实时查重（GET /leads/dup-check）：登记表单电话/微信失焦时调用；
   * 字面量路由必须先于 @Get(':id')（/leads/takeover 同款顺序坑） */
  @Get('dup-check')
  @RequirePermission('m03:edit')
  dupCheck(@Query() query: DupCheckQueryDto) {
    return this.manual.dupCheck(query);
  }

  @Get()
  @RequirePermission('m03:view')
  list(@Query() query: ListLeadsQueryDto, @CurrentUser() actor: JwtPayload) {
    return this.leads.list(actor, query);
  }

  @Get(':id')
  @RequirePermission('m03:view')
  get(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.leads.get(actor, id);
  }

  @Get(':id/events')
  @RequirePermission('m03:view')
  events(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.leads.listEvents(actor, id);
  }

  /** 画像编辑（批次2 T4）：m03:edit；五字段可选至少一项，仅记录与统计不参与分配/SLA */
  @Patch(':id/profile')
  @RequirePermission('m03:edit')
  async updateProfile(
    @Param('id') id: string,
    @Body() dto: UpdateLeadProfileDto,
    @CurrentUser() actor: JwtPayload,
  ): Promise<{ ok: true }> {
    await this.leads.updateProfile(actor, id, dto);
    return { ok: true };
  }

  @Patch(':id/assign')
  @RequirePermission('m03:edit')
  assign(@Param('id') id: string, @Body() body: AssignLeadDto, @CurrentUser() actor: JwtPayload) {
    return this.assignSvc.assign(id, actor, body.ownerUserId, body.reason);
  }

  @Post(':id/claim')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  claim(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.assignSvc.claim(id, actor);
  }

  @Post(':id/contact-attempt')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  contactAttempt(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.leads.recordContactAttempt(actor, id);
  }

  @Post(':id/customer-reply')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  customerReply(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.leads.recordCustomerReply(actor, id);
  }

  @Patch(':id/stage')
  @RequirePermission('m03:edit')
  stage(
    @Param('id') id: string,
    @Body() body: TransitionStageDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.lifecycle.transitionStage(id, body.stage, body.reason, actor);
  }

  @Post(':id/churn-propose')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  churnPropose(
    @Param('id') id: string,
    @Body() body: ProposeChurnDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.lifecycle.proposeChurn(id, actor, body.reason, body.note);
  }

  @Post(':id/reopen')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  reopen(@Param('id') id: string, @Body() body: ReopenLeadDto, @CurrentUser() actor: JwtPayload) {
    return this.lifecycle.reopen(id, actor, body.reason);
  }

  @Post(':id/won')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  won(@Param('id') id: string, @Body() body: MarkWonDto, @CurrentUser() actor: JwtPayload) {
    return this.lifecycle.confirmWon(id, actor, body);
  }

  @Post(':id/invalid')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  invalid(@Param('id') id: string, @Body() body: MarkInvalidDto, @CurrentUser() actor: JwtPayload) {
    return this.lifecycle.markInvalid(id, actor, body.reason);
  }

  @Post(':id/follow-up')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  followUp(
    @Param('id') id: string,
    @Body() body: RecordFollowUpDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.lifecycle.recordFollowUp(id, actor, {
      result: body.result,
      nextAction: body.nextAction,
      nextFollowUpAt: body.nextFollowUpAt,
      waitCustomer: body.waitCustomer ?? false,
    });
  }

  @Post(':id/pause')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  pause(@Param('id') id: string, @Body() body: PauseLeadDto, @CurrentUser() actor: JwtPayload) {
    return this.lifecycle.pause(id, actor, body.reason);
  }

  @Post(':id/resume')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  resume(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.lifecycle.resume(id, actor);
  }

  @Post(':id/takeover')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  takeover(
    @Param('id') id: string,
    @Body() body: TakeoverLeadDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.lifecycle.takeover(id, actor, body);
  }

  @Get(':id/ai-summary')
  @RequirePermission('m03:view')
  getAiSummary(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.summary.getSummary(id, actor);
  }

  /** 手动重提摘要（2026-08-26 O8 评测缺口）：degraded/failed 后一键重试（非终态幂等） */
  @Post(':id/ai-summary/regenerate')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  regenerateAiSummary(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.summary.regenerate(id, actor);
  }

  @Post(':id/ai-summary/feedback')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  submitAiSummaryFeedback(
    @Param('id') id: string,
    @Body() body: AiSummaryFeedbackDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.summary.submitFeedback(id, actor, body);
  }
}
