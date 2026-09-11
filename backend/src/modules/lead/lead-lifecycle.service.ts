import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Lead } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovalRepository } from '../approval/approval.repository';
import { APPROVAL_STATUS } from '../approval/approval.states';
import type { JwtPayload } from '../auth/auth.types';
import { LEAD_EVENT_KIND, type ChurnReason } from './lead.constants';
import { LeadRepository } from './lead.repository';
import { LeadService } from './lead.service';
import {
  canTransitionStage,
  LEAD_FINAL_STATUS,
  LEAD_SILENCE_STAGE,
  LEAD_STAGE,
  type LeadStage,
} from './lead.states';

/** SystemMeta 阶段时限配置键（D-P3-3/P3-04）：JSON 如 {"communicating":3,"quoted":2,"visit_booked":5}，
 * 单位天；缺省/非法值 → 无限（dueAt=null）。 */
const STAGE_DEADLINES_KEY = 'sla.stage.deadlines';

/** 成交入参：closedAmountFen/closeReason 必填；Opportunity 扩展字段可后补（P3-04） */
export interface ConfirmWonInput {
  amountFen: number;
  reason: string;
  visitOriginalPlan?: string;
  visitFinalPlan?: string;
  upsellReason?: string;
  grossMarginImpact?: string;
}

/** 跟进入参（P3-04）：结果/下次动作/下次跟进时间；waitCustomer 决定 nextStep 前缀约定 */
export interface FollowUpInput {
  result: string;
  nextAction: string;
  nextFollowUpAt: Date;
  waitCustomer: boolean;
}

/** 接管入参（P3-04）：原因/证据/下次动作三要素必填 */
export interface TakeoverInput {
  reason: string;
  evidence: string;
  nextAction: string;
}

/**
 * 客资生命周期状态机（P3-04）：阶段推进/成交/无效/跟进/暂停/接管/流失权限流/重开。
 * 全部显式状态机代码（A02）：阶段流转/流失判定由条件迁移与枚举决定，模型输出无权改状态；
 * 任何写动作都不接受 AI 任务 output 作为状态来源（入参 schema 无 output/aiTaskId 字段）。
 */
@Injectable()
export class LeadLifecycleService {
  private readonly logger = new Logger(LeadLifecycleService.name);

  constructor(
    private readonly repo: LeadRepository,
    private readonly leads: LeadService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalRepository,
  ) {}

  /** 阶段推进：canTransitionStage 校验＋reason 必填＋条件迁移防竞态＋事件＋审计＋dueAt。
   * 进入 visit_booked 时懒创建 Opportunity（leadId 唯一，只建一次，D-P3-2）。 */
  async transitionStage(
    leadId: string,
    to: LeadStage,
    reason: string,
    actor: JwtPayload,
  ): Promise<Lead> {
    const lead = await this.getOwnedLead(leadId, actor);
    if (lead.finalStatus !== LEAD_FINAL_STATUS.ACTIVE) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, '非跟进中客资不可推进阶段');
    }
    if (!canTransitionStage(lead.stage as LeadStage, to)) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, `非法阶段迁移：${lead.stage} → ${to}`);
    }
    const dueAt = await this.stageDueAt(to);
    const count = await this.repo.updateIfStage(leadId, lead.stage, { stage: to, dueAt });
    if (count === 0) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, '客资阶段已变化，请刷新');
    }
    await this.repo.appendEvent(
      leadId,
      LEAD_EVENT_KIND.STAGE_CHANGED,
      { from: lead.stage, to, reason },
      actor.sub,
    );
    if (to === LEAD_STAGE.VISIT_BOOKED) {
      await this.ensureOpportunity(lead);
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'lead.stage_changed',
      objectType: 'lead',
      objectId: leadId,
      before: { stage: lead.stage },
      after: { stage: to, reason },
    });
    return (await this.repo.findById(leadId)) as Lead;
  }

  /** 成交：won＋closedAt/closedAmountFen/closeReason 必填；Opportunity 扩展字段可后补。
   * 前置检查（active）之外走条件迁移收口竞态：读后窗口内被并发标记无效/流失时 count=0 → 409。 */
  async confirmWon(leadId: string, actor: JwtPayload, input: ConfirmWonInput): Promise<Lead> {
    const lead = await this.getOwnedLead(leadId, actor);
    if (lead.finalStatus !== LEAD_FINAL_STATUS.ACTIVE) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, '非跟进中客资不可标记成交');
    }
    const count = await this.repo.updateIfFinalStatus(leadId, [LEAD_FINAL_STATUS.ACTIVE], {
      finalStatus: LEAD_FINAL_STATUS.WON,
      closedAt: new Date(),
      closedAmountFen: input.amountFen,
      closeReason: input.reason,
    });
    if (count === 0) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, '客资状态已变化，成交失败，请刷新');
    }
    await this.repo.appendEvent(
      leadId,
      LEAD_EVENT_KIND.WON,
      { amountFen: input.amountFen, reason: input.reason },
      actor.sub,
    );
    await this.backfillOpportunityFields(leadId, {
      visitOriginalPlan: input.visitOriginalPlan,
      visitFinalPlan: input.visitFinalPlan,
      upsellReason: input.upsellReason,
      grossMarginImpact: input.grossMarginImpact,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'lead.won',
      objectType: 'lead',
      objectId: leadId,
      after: { amountFen: input.amountFen, reason: input.reason },
    });
    return (await this.repo.findById(leadId)) as Lead;
  }

  /** 无效：invalid＋closedAt＋原因。条件迁移同 confirmWon 口径（active 前置，防并发跨终态）。 */
  async markInvalid(leadId: string, actor: JwtPayload, reason: string): Promise<Lead> {
    const lead = await this.getOwnedLead(leadId, actor);
    if (lead.finalStatus !== LEAD_FINAL_STATUS.ACTIVE) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, '非跟进中客资不可标记无效');
    }
    const count = await this.repo.updateIfFinalStatus(leadId, [LEAD_FINAL_STATUS.ACTIVE], {
      finalStatus: LEAD_FINAL_STATUS.INVALID,
      closedAt: new Date(),
      closeReason: reason,
    });
    if (count === 0) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, '客资状态已变化，操作失败，请刷新');
    }
    await this.repo.appendEvent(leadId, LEAD_EVENT_KIND.INVALID, { reason }, actor.sub);
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'lead.invalid',
      objectType: 'lead',
      objectId: leadId,
      after: { reason },
    });
    return (await this.repo.findById(leadId)) as Lead;
  }

  /** 跟进记录：每轮一次（结果/下次动作/下次跟进时间）；nextStep 前缀 wait_customer:/todo: 区分。 */
  async recordFollowUp(leadId: string, actor: JwtPayload, input: FollowUpInput): Promise<Lead> {
    const lead = await this.getOwnedLead(leadId, actor);
    if (lead.finalStatus !== LEAD_FINAL_STATUS.ACTIVE) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, '非跟进中客资不可记录跟进');
    }
    const prefix = input.waitCustomer ? 'wait_customer:' : 'todo:';
    const nextStep = `${prefix}${input.nextAction}`;
    await this.repo.update(leadId, {
      lastFollowUpAt: new Date(),
      lastFollowUpResult: input.result,
      nextStep,
      nextFollowUpAt: input.nextFollowUpAt,
    });
    await this.repo.appendEvent(
      leadId,
      LEAD_EVENT_KIND.FOLLOWUP_RECORDED,
      { result: input.result, nextStep, nextFollowUpAt: input.nextFollowUpAt },
      actor.sub,
    );
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'lead.followup',
      objectType: 'lead',
      objectId: leadId,
      after: { nextStep },
    });
    return (await this.repo.findById(leadId)) as Lead;
  }

  /** 暂停（仅 boss/store_manager）：pausedAt＋paused 事件；暂停期 SLA/沉默/轮询跳过。 */
  async pause(leadId: string, actor: JwtPayload, reason: string): Promise<Lead> {
    await this.assertGlobal(actor, '仅老板/店长可暂停客资');
    const lead = await this.repo.findById(leadId);
    if (!lead) throw new AppException(ErrorCode.NOT_FOUND, '客资不存在');
    if (lead.finalStatus !== LEAD_FINAL_STATUS.ACTIVE) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, '仅跟进中客资可暂停');
    }
    if (lead.pausedAt) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, '客资已暂停');
    }
    await this.repo.update(leadId, { pausedAt: new Date() });
    await this.repo.appendEvent(leadId, LEAD_EVENT_KIND.PAUSED, { reason }, actor.sub);
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'lead.paused',
      objectType: 'lead',
      objectId: leadId,
      after: { reason },
    });
    return (await this.repo.findById(leadId)) as Lead;
  }

  /** 恢复（仅 boss/store_manager）：清 pausedAt＋resumed 事件。 */
  async resume(leadId: string, actor: JwtPayload): Promise<Lead> {
    await this.assertGlobal(actor, '仅老板/店长可恢复客资');
    const lead = await this.repo.findById(leadId);
    if (!lead) throw new AppException(ErrorCode.NOT_FOUND, '客资不存在');
    if (!lead.pausedAt) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, '客资未暂停');
    }
    await this.repo.update(leadId, { pausedAt: null });
    await this.repo.appendEvent(leadId, LEAD_EVENT_KIND.RESUMED, {}, actor.sub);
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'lead.resumed',
      objectType: 'lead',
      objectId: leadId,
    });
    return (await this.repo.findById(leadId)) as Lead;
  }

  /** 人工接管（仅 boss/store_manager）：改派自己＋Opportunity.takeover=true＋三要素留痕。 */
  async takeover(leadId: string, actor: JwtPayload, input: TakeoverInput): Promise<Lead> {
    await this.assertGlobal(actor, '仅老板/店长可接管客资');
    const lead = await this.repo.findById(leadId);
    if (!lead) throw new AppException(ErrorCode.NOT_FOUND, '客资不存在');
    await this.repo.update(leadId, { ownerUserId: actor.sub, assignedAt: new Date() });
    await this.repo.appendEvent(
      leadId,
      LEAD_EVENT_KIND.TAKEOVER,
      {
        fromOwner: lead.ownerUserId,
        toOwner: actor.sub,
        reason: input.reason,
        evidence: input.evidence,
        nextAction: input.nextAction,
      },
      actor.sub,
    );
    const opp = await this.repo.findOpportunityByLeadId(leadId);
    if (opp) {
      await this.repo.updateOpportunity(opp.id, {
        takeover: true,
        takeoverReason: input.reason,
        ownerUserId: actor.sub,
      });
    } else {
      try {
        await this.repo.createOpportunity({
          leadId,
          customerId: lead.customerId,
          ownerUserId: actor.sub,
          takeover: true,
          takeoverReason: input.reason,
        });
      } catch (err) {
        if (!isUniqueConstraint(err)) throw err;
      }
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'lead.takeover',
      objectType: 'lead',
      objectId: leadId,
      before: { ownerUserId: lead.ownerUserId },
      after: { ownerUserId: actor.sub, reason: input.reason },
    });
    return (await this.repo.findById(leadId)) as Lead;
  }

  /** 建议流失（owner 本人或 boss/store_manager 代提）：reason 枚举必选。
   * finalStatus ∈ {active, silence} 可提议（沉默 14d 后人工确认最终流失即走此路径，P3-04）；
   * lost_pending（已有待审批）/lost/won/invalid 不可重复提议。 */
  async proposeChurn(
    leadId: string,
    actor: JwtPayload,
    reason: ChurnReason,
    note?: string,
  ): Promise<{ approvalId: string; finalStatus: string }> {
    const lead = await this.getOwnedLead(leadId, actor);
    if (
      lead.finalStatus !== LEAD_FINAL_STATUS.ACTIVE &&
      lead.finalStatus !== LEAD_FINAL_STATUS.SILENCE
    ) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, '仅跟进中或沉默客资可建议流失');
    }
    const fromStatus = lead.finalStatus;
    // 条件迁移收口竞态：读后窗口内被并发提议/终态化时 count=0 → 409（避免并发双提议落两个审批项）
    const count = await this.repo.updateIfFinalStatus(
      leadId,
      [LEAD_FINAL_STATUS.ACTIVE, LEAD_FINAL_STATUS.SILENCE],
      {
        finalStatus: LEAD_FINAL_STATUS.LOST_PENDING,
        lostReason: reason,
      },
    );
    if (count === 0) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, '客资状态已变化，提议失败，请刷新');
    }
    await this.repo.appendEvent(
      leadId,
      LEAD_EVENT_KIND.CHURN_PROPOSED,
      { reason, note, fromStatus },
      actor.sub,
    );
    const item = await this.approvals.create({
      type: 'lead.churn',
      payload: { leadId, reason, note, fromStatus },
      requesterId: actor.sub,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'lead.churn_proposed',
      objectType: 'lead',
      objectId: leadId,
      after: { approvalId: item.id, reason, fromStatus },
    });
    return { approvalId: item.id, finalStatus: LEAD_FINAL_STATUS.LOST_PENDING };
  }

  /** 流失审批决定回写钩子（approval.service 决定成功后调用）：
   * 批准 → lost＋closedAt＋churn_decided 事件；驳回 → 恢复原 finalStatus（active 或 silence）＋churn_decided 事件。
   *
   * 失败模式与对账：本方法非事务，approval.transit 已 commit 后此处写 lead；若进程在此中断/写失败，
   * 会留下「approval=approved/rejected 而 lead 仍 lost_pending」的悬空态，且无法重新 approve。
   * 因此本方法保持幂等（仅 lost_pending 态施加），并提供 reconcileChurnDecisions() 作为对账入口
   * （cron 每小时第 9 分调用），扫描已决定的 lead.churn 审批项重放本方法。 */
  async applyChurnDecision(itemId: string, approved: boolean): Promise<void> {
    const item = await this.approvals.findById(itemId);
    if (!item || item.type !== 'lead.churn') return;
    const payload = item.payload as {
      leadId?: unknown;
      reason?: unknown;
      fromStatus?: unknown;
    } | null;
    if (!payload || typeof payload.leadId !== 'string' || !payload.leadId) return;
    const leadId = payload.leadId;
    const lead = await this.repo.findById(leadId);
    if (!lead) return;
    // 幂等：仅在 lost_pending 态回写（审批项单次决定，重复调用/并发不重复施加）
    if (lead.finalStatus !== LEAD_FINAL_STATUS.LOST_PENDING) return;

    if (approved) {
      // 条件迁移把「仅 lost_pending 施加」的幂等从读检查升级为原子检查（T5）：
      // 审批决定回写与对账 cron 重放并发时只有一个执行者拿到 count=1，另一个静默跳过（不双写事件）
      const count = await this.repo.updateIfFinalStatus(leadId, [LEAD_FINAL_STATUS.LOST_PENDING], {
        finalStatus: LEAD_FINAL_STATUS.LOST,
        closedAt: new Date(),
      });
      if (count === 0) return;
      await this.repo.appendEvent(leadId, LEAD_EVENT_KIND.CHURN_DECIDED, {
        decision: 'approved',
        itemId,
        reason: payload.reason,
      });
    } else {
      // 驳回：恢复提议前原状态（沉默客资提议流失后驳回应回 silence，非 active）；幂等同上
      const restore =
        payload.fromStatus === LEAD_FINAL_STATUS.SILENCE
          ? LEAD_FINAL_STATUS.SILENCE
          : LEAD_FINAL_STATUS.ACTIVE;
      const count = await this.repo.updateIfFinalStatus(leadId, [LEAD_FINAL_STATUS.LOST_PENDING], {
        finalStatus: restore,
        lostReason: null,
      });
      if (count === 0) return;
      await this.repo.appendEvent(leadId, LEAD_EVENT_KIND.CHURN_DECIDED, {
        decision: 'rejected',
        itemId,
        restoredTo: restore,
      });
    }
    await this.audit.record({
      actorId: item.approverId ?? undefined,
      action: 'lead.churn_decided',
      objectType: 'lead',
      objectId: leadId,
      after: { approved, approvalId: itemId },
    });
  }

  /** 流失决定对账 cron（每小时第 9 分，与沉默链第 7 分错开）：重放「已决定但 lead 仍 lost_pending」的写回。 */
  @Cron('0 9 * * * *')
  async cronReconcileChurn(): Promise<void> {
    await this.reconcileChurnDecisions();
  }

  /** 对账：扫描 type='lead.churn' 且已决定（approved/rejected）的审批项，
   * 若对应 lead 仍 lost_pending（决定写回失败/中断）则重放 applyChurnDecision（幂等）；返回重放条数。 */
  async reconcileChurnDecisions(): Promise<number> {
    const decided = await this.approvals.findDecidedChurnItems();
    let replayed = 0;
    for (const item of decided) {
      const payload = item.payload as { leadId?: unknown } | null;
      if (!payload || typeof payload.leadId !== 'string' || !payload.leadId) continue;
      const lead = await this.repo.findById(payload.leadId);
      if (!lead || lead.finalStatus !== LEAD_FINAL_STATUS.LOST_PENDING) continue;
      await this.applyChurnDecision(item.id, item.status === APPROVAL_STATUS.APPROVED);
      replayed++;
    }
    return replayed;
  }

  /** 重开（仅 boss/store_manager）：回 active、保留原流失记录、reopened 事件；owner 不变（从未清除）。
   * 条件迁移收口竞态：读后窗口内被并发重开/终态化时 count=0 → 409。 */
  async reopen(leadId: string, actor: JwtPayload, reason: string): Promise<Lead> {
    await this.assertGlobal(actor, '仅老板/店长可重开客资');
    const lead = await this.repo.findById(leadId);
    if (!lead) throw new AppException(ErrorCode.NOT_FOUND, '客资不存在');
    if (lead.finalStatus !== LEAD_FINAL_STATUS.LOST) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, '仅已流失客资可重开');
    }
    const count = await this.repo.updateIfFinalStatus(leadId, [LEAD_FINAL_STATUS.LOST], {
      finalStatus: LEAD_FINAL_STATUS.ACTIVE,
      silenceStage: LEAD_SILENCE_STAGE.NONE,
      lostReason: null,
      closedAt: null,
    });
    if (count === 0) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, '客资状态已变化，重开失败，请刷新');
    }
    await this.repo.appendEvent(leadId, LEAD_EVENT_KIND.REOPENED, { reason }, actor.sub);
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'lead.reopened',
      objectType: 'lead',
      objectId: leadId,
      after: { reason },
    });
    return (await this.repo.findById(leadId)) as Lead;
  }

  /** 负责人或全局校验后返回客资（复用 LeadService.assertOwnerOrGlobal）。 */
  private async getOwnedLead(leadId: string, actor: JwtPayload): Promise<Lead> {
    const lead = await this.repo.findById(leadId);
    if (!lead) throw new AppException(ErrorCode.NOT_FOUND, '客资不存在');
    await this.leads.assertOwnerOrGlobal(actor, lead);
    return lead;
  }

  /** 全局角色（boss/store_manager）强制校验。 */
  private async assertGlobal(actor: JwtPayload, message: string): Promise<void> {
    if (!(await this.leads.isGlobal(actor))) {
      throw new AppException(ErrorCode.PERM_DENIED, message);
    }
  }

  /** 懒创建 Opportunity（leadId 唯一）：并发创建命中 P2002 视为已存在，保证只建一次。 */
  private async ensureOpportunity(lead: Lead): Promise<void> {
    const existing = await this.repo.findOpportunityByLeadId(lead.id);
    if (existing) return;
    try {
      await this.repo.createOpportunity({
        leadId: lead.id,
        customerId: lead.customerId,
        ownerUserId: lead.ownerUserId,
        stage: LEAD_STAGE.VISIT_BOOKED,
      });
    } catch (err) {
      if (!isUniqueConstraint(err)) throw err;
    }
  }

  /** Opportunity 扩展字段后补（仅写已提供字段；无 Opportunity 时跳过）。 */
  private async backfillOpportunityFields(
    leadId: string,
    fields: Record<string, string | undefined>,
  ): Promise<void> {
    const defined = Object.fromEntries(
      Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    if (Object.keys(defined).length === 0) return;
    const opp = await this.repo.findOpportunityByLeadId(leadId);
    if (!opp) return;
    await this.repo.updateOpportunity(opp.id, defined);
  }

  /** 按 SystemMeta sla.stage.deadlines 计算当前阶段 dueAt（缺省/非法 → null=无限）。 */
  private async stageDueAt(stage: LeadStage): Promise<Date | null> {
    const meta = await this.prisma.systemMeta.findUnique({ where: { key: STAGE_DEADLINES_KEY } });
    if (!meta) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(meta.value);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`阶段时限配置解析失败，回退无限（key=${STAGE_DEADLINES_KEY}）：${detail}`);
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const days = (parsed as Record<string, unknown>)[stage];
    if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return null;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }
}

/** Prisma 唯一约束冲突识别（P2002），复用 repository 同款判定逻辑 */
function isUniqueConstraint(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}
