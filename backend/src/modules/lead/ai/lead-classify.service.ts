import { Injectable } from '@nestjs/common';
import type { AiTask } from '@prisma/client';

import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { JwtPayload } from '../../auth/auth.types';
import { AiDispatchService } from '../../ai-dispatch/ai-dispatch.service';
import { AiTaskRepository } from '../../ai-dispatch/ai-task.repository';
import { CustomerRefService } from '../../ai-dispatch/customer-ref.service';
import { LEAD_EVENT_KIND } from '../lead.constants';
import { LeadRepository } from '../lead.repository';
import { LeadService } from '../lead.service';
import {
  LeadClassifyOutputSchema,
  type LeadClassifyOutput,
  leadAiProgressOf,
  type LeadAiProgress,
  applyDealSignalRule,
} from './lead-ai.module';

/** 意向分级建议视图（建议态）：taskId 供确认端点定位；输出字段经 Zod 校验后展开。 */
export interface IntentProposalView extends LeadClassifyOutput {
  taskId: string;
  createdAt: Date;
}

/** 意向建议状态视图（2026-08-26 O8 评测缺口）：进度看最新一条任务，内容兜底取最新 done——
 * 详情页据此轮询刷新与展示「生成中/失败可重试/待确认」。 */
export interface IntentProposalStatusView {
  status: LeadAiProgress;
  proposal: IntentProposalView | null;
}

/** 确认返回体：最终落库等级 + 是否人工改判 + 留痕内容（供前端/测试断言）。 */
export interface IntentConfirmView {
  leadId: string;
  intentLevel: string;
  aiLevel: string;
  humanLevel: string;
  overridden: boolean;
  intentConfirmedBy: string;
}

/** 改判留痕事件 content（P3-07）：level 与 AI 建议不一致时记录 aiLevel/humanLevel/reason（学习链数据）。 */
type IntentConfirmContent = {
  taskId: string;
  aiLevel: string;
  humanLevel: string;
  reason?: string | null;
  overridden: boolean;
};

/**
 * lead.classify 读侧与人工确认（P3-07）：
 * - submitClassify：手工 POST /leads/:id/classify（非幂等，每次生成新建议）。
 * - getProposals：取该 lead 最新 done 的 lead.classify 任务 output（待确认建议）。
 * - confirm：人工确认/改判——写 intentLevel/intentEvidence/intentConfirmedBy＋intent_confirmed 事件；
 *   level 与 AI 建议不一致时事件 content 记录 {aiLevel, humanLevel, reason}（改判留痕）。
 * 分级建议只落 ai_tasks.output；未确认不影响排序/分配/兜底（这些只读 lead.intentLevel 确认后字段）。
 */
@Injectable()
export class LeadClassifyService {
  constructor(
    private readonly dispatch: AiDispatchService,
    private readonly tasks: AiTaskRepository,
    private readonly repo: LeadRepository,
    private readonly leads: LeadService,
    private readonly customerRef: CustomerRefService,
  ) {}

  /** 手工触发分级：构造脱敏上下文提交任务（同步闭环，返回终态任务视图）。 */
  async submitClassify(
    leadId: string,
    actor: JwtPayload,
  ): Promise<{ taskId: string; status: string }> {
    const lead = await this.getOwnedLead(leadId, actor);
    const refId = lead.customerId ? await this.customerRef.getOrCreate(lead.customerId) : lead.id;
    const context = {
      refId,
      sourcePlatform: lead.sourcePlatform,
      businessType: lead.businessType,
      target: lead.target ?? null,
      productNeed: lead.productNeed ?? null,
      rawNeed: lead.rawNeed ?? null,
      stage: lead.stage,
      lastFollowUpResult: lead.lastFollowUpResult ?? null,
      receivedAt: lead.receivedAt ?? null,
      firstCustomerReplyAt: lead.firstCustomerReplyAt ?? null,
    };
    const task = await this.dispatch.submitTaskAutoRetry('lead.classify', context, {
      type: 'lead',
      id: leadId,
    });
    // 确定性规则后验（同 trigger：成交级信号命中即校正 high 写回）
    if (task.status === 'done' && task.output) {
      const out = task.output as { level?: string; confidence?: number; evidence?: unknown };
      const corrected = applyDealSignalRule(context, out);
      if (corrected) await this.tasks.saveOutput(task.id, { ...out, ...corrected });
    }
    return { taskId: task.id, status: task.status };
  }

  /** 意向建议状态视图（2026-08-26 O8 评测缺口）：进度看最新一条任务（任意状态），
   * 内容兜底取最新 done——最新一次 degraded/failed 时仍回旧建议供确认。 */
  async getProposals(leadId: string, actor: JwtPayload): Promise<IntentProposalStatusView> {
    await this.getOwnedLead(leadId, actor);
    const latest = await this.tasks.findLatestByRef('lead', leadId, 'lead.classify');
    if (!latest) return { status: 'none', proposal: null };
    const status = leadAiProgressOf(latest.status);
    const done =
      latest.status === 'done'
        ? latest
        : await this.tasks.findLatestDoneByRef('lead', leadId, 'lead.classify');
    if (!done?.output) return { status, proposal: null };
    const parsed = LeadClassifyOutputSchema.safeParse(done.output);
    if (!parsed.success) return { status, proposal: null }; // 已落库输出必已通过校验，防御性兜底
    return { status, proposal: { taskId: done.id, createdAt: done.createdAt, ...parsed.data } };
  }

  /** 人工确认/改判：校验 taskId 属该 lead 且 status=done，写业务字段＋intent_confirmed 事件。
   * level 缺省＝沿用 AI 建议等级；提供 level 且与 AI 不一致＝改判（事件记录 aiLevel/humanLevel/reason）。 */
  async confirm(
    leadId: string,
    actor: JwtPayload,
    body: { taskId: string; level?: string; reason?: string | null },
  ): Promise<IntentConfirmView> {
    await this.getOwnedLead(leadId, actor);
    const task = await this.getOwnedDoneClassifyTask(leadId, body.taskId);
    const parsed = LeadClassifyOutputSchema.safeParse(task.output);
    if (!parsed.success) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, '分级任务输出无效，无法确认');
    }
    const aiLevel = parsed.data.level;
    const humanLevel = body.level ?? aiLevel;
    const overridden = humanLevel !== aiLevel;
    // 2026-08-28 P2：改判必填理由（手册环节 3「改判需填理由，双口径留痕」）——
    // 此前 reason 可选，不填也能改判，留痕缺理由。仅确认（不改判）不需理由。
    const reason = body.reason?.trim() ?? '';
    if (overridden && reason.length < 2) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, '改判必须填写理由（≥2字，供双口径留痕）');
    }

    await this.repo.update(leadId, {
      intentLevel: humanLevel,
      intentEvidence: parsed.data.evidence,
      intentConfirmedBy: actor.sub,
    });

    const content: IntentConfirmContent = {
      taskId: task.id,
      aiLevel,
      humanLevel,
      overridden,
      ...(overridden ? { reason } : {}),
    };
    await this.repo.appendEvent(leadId, LEAD_EVENT_KIND.INTENT_CONFIRMED, content, actor.sub);

    return {
      leadId,
      intentLevel: humanLevel,
      aiLevel,
      humanLevel,
      overridden,
      intentConfirmedBy: actor.sub,
    };
  }

  /** 负责人或全局校验后返回客资。 */
  private async getOwnedLead(leadId: string, actor: JwtPayload) {
    const lead = await this.repo.findById(leadId);
    if (!lead) throw new AppException(ErrorCode.NOT_FOUND, '客资不存在');
    await this.leads.assertOwnerOrGlobal(actor, lead);
    return lead;
  }

  /** 校验分级任务归属：refType='lead' 且 refId=leadId 且 taskType='lead.classify' 且 status=done；
   * 归属不符一律 NOT_FOUND（不泄露他人任务存在性）；未闭环建议不可确认。 */
  private async getOwnedDoneClassifyTask(leadId: string, taskId: string): Promise<AiTask> {
    const task = await this.tasks.findById(taskId);
    if (
      !task ||
      task.refType !== 'lead' ||
      task.refId !== leadId ||
      task.taskType !== 'lead.classify' ||
      task.status !== 'done'
    ) {
      throw new AppException(ErrorCode.NOT_FOUND, '分级任务不存在、不属于该客资或尚未完成');
    }
    return task;
  }
}
