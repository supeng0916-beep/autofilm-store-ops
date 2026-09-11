import { Injectable } from '@nestjs/common';
import type { Lead } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { JwtPayload } from '../auth/auth.types';
import { UsersRepository } from '../auth/users.repository';
import { LeadClassifyTrigger } from './ai/lead-classify.trigger';
import { withLlmCap } from './ai/trigger-cap.util';
import { LeadRepository, type LeadListFilters } from './lead.repository';
import { isGlobalRole } from './lead.states';
import { SilenceService } from './silence.service';
import { computeSla, SlaService, type LeadSla } from './sla.service';

/** 队列项：Lead + sla 派生字段 + 负责人姓名（GET /leads 返回体；
 * 2026-08-28 bug1：ownerName 供前端直显，不再把 cuid 内部 ID 当名字展示） */
export type LeadListItem = Lead & { sla: LeadSla; ownerName: string | null };

/** chatLink 脱敏（红线）：仅 boss/store_manager 可见，其余角色剥为 null，绝不进日志 */
function sanitizeLead<T extends { chatLink: string | null }>(lead: T, showChatLink: boolean): T {
  if (showChatLink) return lead;
  return { ...lead, chatLink: null };
}

/** 客资查询域（GET /leads、GET /leads/:id、首次触达/客户回复）：强制数据范围＋chatLink 按角色过滤。
 * 分配/认领/改派写在 AssignService；SLA 计时与升级写在 SlaService；本服务只做读侧范围、脱敏与时间戳写入口。 */
@Injectable()
export class LeadService {
  constructor(
    private readonly repo: LeadRepository,
    private readonly users: UsersRepository,
    private readonly sla: SlaService,
    private readonly silence: SilenceService,
    private readonly classify: LeadClassifyTrigger,
    private readonly audit: AuditService,
  ) {}

  /** 队列查询：scope 强制（sales_ops 仅本人，boss/store_manager 全局），叠加可选过滤。
   * 返回体带 sla 派生字段（service 层用 businessMinutesBetween 现算，倒计时以违约阈值为截止）。 */
  async list(
    actor: JwtPayload,
    query: LeadListFilters & { owner?: string },
  ): Promise<LeadListItem[]> {
    const global = await this.isGlobal(actor);
    const scope = global ? {} : { ownerUserId: actor.sub };
    // sales_ops 恒本人，忽略 query.owner；全局角色才允许按负责人过滤
    const { owner, ...filters } = global ? { ...query } : { ...query, owner: undefined };
    // 2026-08-28 bug1：负责人按姓名过滤（后端反查用户 ID）；无匹配→空结果，不退回 ID 匹配
    let effective: LeadListFilters = filters;
    if (owner?.trim()) {
      const ownerIds = await this.users.findIdsByDisplayNameLike(owner.trim());
      if (ownerIds.length === 0) return [];
      effective = { ...filters, ownerIds };
    }
    const leads = await this.repo.findManyByScope(scope, effective);

    const config = await this.sla.loadConfig();
    const now = new Date();
    const ownerIdSet = [
      ...new Set(leads.map((l) => l.ownerUserId).filter((v): v is string => Boolean(v))),
    ];
    const ownerNameById = await this.users.findDisplayNamesByIds(ownerIdSet);
    return leads.map((lead) => ({
      ...sanitizeLead(lead, global),
      ownerName: lead.ownerUserId ? (ownerNameById.get(lead.ownerUserId) ?? null) : null,
      sla: computeSla(lead, now, config),
    }));
  }

  /** 详情：范围校验（本人或全局）＋chatLink 按角色过滤＋sla 派生字段（详情页 SLA 卡）＋负责人姓名。 */
  /** 画像编辑（批次2 T4）：五字段可选更新；审计 lead.profile_updated（before/after 摘要） */
  async updateProfile(
    actor: JwtPayload,
    id: string,
    dto: {
      gender?: string;
      ageBand?: string;
      industry?: string;
      district?: string;
      purchaseDealer?: string;
    },
  ): Promise<void> {
    const lead = await this.repo.findById(id);
    if (!lead) throw new AppException(ErrorCode.NOT_FOUND, '客资不存在');
    await this.assertOwnerOrGlobal(actor, lead);
    const data: Record<string, string | undefined> = {
      gender: dto.gender,
      ageBand: dto.ageBand,
      industry: dto.industry,
      district: dto.district,
      purchaseDealer: dto.purchaseDealer,
    };
    for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
    await this.repo.update(id, data);
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'lead.profile_updated',
      objectType: 'lead',
      objectId: id,
      before: {
        gender: lead.gender,
        ageBand: lead.ageBand,
        industry: lead.industry,
        district: lead.district,
        purchaseDealer: lead.purchaseDealer,
      },
      after: data,
    });
  }

  async get(
    actor: JwtPayload,
    id: string,
  ): Promise<Lead & { sla: LeadSla; ownerName: string | null }> {
    const lead = await this.repo.findById(id);
    if (!lead) throw new AppException(ErrorCode.NOT_FOUND, '客资不存在');
    await this.assertOwnerOrGlobal(actor, lead);
    const config = await this.sla.loadConfig();
    const ownerName = lead.ownerUserId
      ? ((await this.users.findDisplayNamesByIds([lead.ownerUserId])).get(lead.ownerUserId) ?? null)
      : null;
    return {
      ...sanitizeLead(lead, await this.isGlobal(actor)),
      ownerName,
      sla: computeSla(lead, new Date(), config),
    };
  }

  /** 首次触达登记（人工发起，本端点是唯一写入 firstContactAttemptAt 的路径）：
   * m03:edit + assertOwnerOrGlobal；已记录则幂等保留首次时间。 */
  async recordContactAttempt(
    actor: JwtPayload,
    id: string,
  ): Promise<{ id: string; firstContactAttemptAt: Date }> {
    const lead = await this.repo.findById(id);
    if (!lead) throw new AppException(ErrorCode.NOT_FOUND, '客资不存在');
    await this.assertOwnerOrGlobal(actor, lead);
    const firstContactAttemptAt = lead.firstContactAttemptAt ?? new Date();
    if (!lead.firstContactAttemptAt) {
      await this.repo.update(id, { firstContactAttemptAt });
    }
    return { id, firstContactAttemptAt };
  }

  /** 客户首次回复登记（Task 9 复活也用）：firstCustomerReplyAt 仍只记首次（五类时间戳语义不变）；
   * 每次回复都刷新 lastFollowUpAt=now（沉默链基线，防复活后立即回 risk 的 flapping，P3-04）。
   * 追加沉默复活：新消息到来即清沉默档/回 active（无冷却期）。
   * P3-07：首次回复或复活时自动触发意向分级（幂等；失败不阻断本动作，建议态不影响业务）。 */
  async recordCustomerReply(
    actor: JwtPayload,
    id: string,
  ): Promise<{ id: string; firstCustomerReplyAt: Date }> {
    const lead = await this.repo.findById(id);
    if (!lead) throw new AppException(ErrorCode.NOT_FOUND, '客资不存在');
    await this.assertOwnerOrGlobal(actor, lead);
    const now = new Date();
    const isFirstReply = !lead.firstCustomerReplyAt;
    const firstCustomerReplyAt = lead.firstCustomerReplyAt ?? now;
    await this.repo.update(id, {
      ...(isFirstReply ? { firstCustomerReplyAt: now } : {}),
      lastFollowUpAt: now,
    });
    const revived = await this.silence.reviveIfApplicable(lead);
    if (isFirstReply || revived) {
      // 2026-08-27 全流程测试 #1：分级触发封顶 3 秒（曾同步等 10 秒挂起响应；
      // 假网关瞬时完成保证同步语义，真实网关超时后任务后台继续、详情页轮询可见）
      await withLlmCap(this.classify.onReply(lead));
    }
    return { id, firstCustomerReplyAt };
  }

  /** 时间线（GET /leads/:id/events，P3-06）：范围校验后返回该客资全部事件倒序。
   * 事件内容为业务事实留痕（阶段/跟进/草稿/发送），不含 chatLink；可见性随客资范围。 */
  async listEvents(actor: JwtPayload, id: string) {
    const lead = await this.repo.findById(id);
    if (!lead) throw new AppException(ErrorCode.NOT_FOUND, '客资不存在');
    await this.assertOwnerOrGlobal(actor, lead);
    return this.repo.findEventsByLead(id);
  }

  /** 负责人或全局角色校验（P3-04 复用：owner 本人或 boss/store_manager）。 */
  async assertOwnerOrGlobal(actor: JwtPayload, lead: Lead): Promise<void> {
    if (await this.isGlobal(actor)) return;
    if (lead.ownerUserId === actor.sub) return;
    throw new AppException(ErrorCode.LEAD_NOT_OWNER, '无权限访问该客资');
  }

  /** 全局角色（boss/store_manager）判定。 */
  async isGlobal(actor: JwtPayload): Promise<boolean> {
    const user = await this.users.findById(actor.sub);
    return isGlobalRole(user?.userRoles.map((ur) => ur.role.code) ?? []);
  }
}
