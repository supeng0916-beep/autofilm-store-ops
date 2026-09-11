import { Injectable, Logger } from '@nestjs/common';
import type { Lead, Prisma } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../auth/auth.types';
import { UsersRepository } from '../auth/users.repository';
import { LeadSummaryTrigger } from './ai/lead-summary.trigger';
import { withLlmCap } from './ai/trigger-cap.util';
import { LeadClassifyTrigger } from './ai/lead-classify.trigger';
import { LEAD_EVENT_KIND } from './lead.constants';
import { LeadRepository } from './lead.repository';
import { isGlobalRole } from './lead.states';

/** SystemMeta 分配配置键（D-P3-6）：池/老板/游标/在跟上限，均可上线后改，缺省取占位默认 */
export const ASSIGN_META_KEYS = {
  onlinePool: 'assign.pool.online',
  fourSPool: 'assign.pool.4s',
  boss: 'assign.boss',
  cursor: 'assign.cursor',
  maxActive: 'assign.maxActivePerOwner',
} as const;

/** 占位默认值对齐 scripts/seed.ts 实际创建的 ph-* 账号（勿硬编码未 seed 的 username）；
 * 上线前 leader 经 SystemMeta 配置真实名单（老板柯总/负责人乙 zhenjie/销售甲 ajing/销售乙 amei/店长店长甲）。 */
const DEFAULT_ONLINE_POOL = ['ph-sales-ops'];
const DEFAULT_FOURS_POOL = ['ph-store-manager'];
const DEFAULT_BOSS = 'ph-boss';
const DEFAULT_MAX_ACTIVE = 30;

/** 分配路由上下文：人员池/游标/在跟数/禁用集合——由 AssignService 从 SystemMeta+DB 装配后传入，
 * 保持 routeLead 纯函数（不触 DB）。userIdByUsername：池 username→userId；
 * usernameByUserId：任意 userId→username（dup/referral 负责人判 disabled 用）。 */
export interface RouteContext {
  onlinePool: string[];
  fourSPool: string[];
  bossUsername: string;
  cursor: number;
  activeCount: Map<string, number>; // username → 在跟数
  disabled: Set<string>; // 请假/离线 username
  maxActive: number;
  userIdByUsername: Map<string, string>;
  usernameByUserId: Map<string, string>;
}

/** 分配路由入参：dupOwnerUserId/referralOwnerUserId 均为 userId（由 service 解析后传入） */
export interface RouteLeadInput {
  dupOfLeadId?: string | null;
  dupOwnerUserId?: string | null;
  sourcePlatform: string;
  acquisitionMethod?: string | null;
  referralOwnerUserId?: string | null;
}

/** 分配决策：ownerUserId 为最终负责人 userId（null=不分配）；fromPool=true 表示经池轮询命中，
 * 落库后需推进游标（dup/转介绍/到店/兜底不消费池槽位，不推进）。 */
export interface RouteDecision {
  ownerUserId: string | null;
  reason: string;
  fromPool: boolean;
}

/** AssignService.route 返回 */
export interface RouteResult {
  ownerUserId: string | null;
  reason: string;
}

/** 到店判定：来源平台含「到店」或获客方式='到店'（不自动分配，等接待人认领） */
export function isWalkInLead(input: {
  sourcePlatform: string;
  acquisitionMethod?: string | null;
}): boolean {
  return input.sourcePlatform.includes('到店') || input.acquisitionMethod === '到店';
}

/** 分配路由纯函数（D-P3-6 路由顺序）：① 重复沿用原负责人 ② 到店→null 等认领 ③ 转介绍回原维护人
 * ④ 4S 池轮询 ⑤ 线上池轮询 ⑥ 池空/无人→老板兜底。dup/referral 负责人已 disabled 时落入轮询分支。 */
export function routeLead(input: RouteLeadInput, ctx: RouteContext): RouteDecision {
  // ① 重复客资沿用原负责人（负责人已 disabled 时落入轮询分支）
  if (input.dupOfLeadId && input.dupOwnerUserId) {
    const username = ctx.usernameByUserId.get(input.dupOwnerUserId);
    if (!(username && ctx.disabled.has(username))) {
      return { ownerUserId: input.dupOwnerUserId, reason: '重复客资沿用原负责人', fromPool: false };
    }
  }
  // ② 到店 → 不自动分配，等接待人手工认领
  if (isWalkInLead(input)) {
    return { ownerUserId: null, reason: '到店客资待接待人手工认领', fromPool: false };
  }
  // ③ 转介绍 → 原关系维护人（已 disabled 时落入轮询分支）
  if (input.referralOwnerUserId) {
    const username = ctx.usernameByUserId.get(input.referralOwnerUserId);
    if (!(username && ctx.disabled.has(username))) {
      return {
        ownerUserId: input.referralOwnerUserId,
        reason: '转介绍回原关系维护人',
        fromPool: false,
      };
    }
  }
  // ④⑤ 池内轮询：4S→店长池，其余→线上池；跳过 disabled/达在跟上限/无账号映射者
  const pool = input.sourcePlatform === '4S店' ? ctx.fourSPool : ctx.onlinePool;
  for (let i = 0; i < pool.length; i++) {
    const candidate = pool[(ctx.cursor + i) % pool.length];
    if (ctx.disabled.has(candidate)) continue;
    if ((ctx.activeCount.get(candidate) ?? 0) >= ctx.maxActive) continue;
    const userId = ctx.userIdByUsername.get(candidate);
    if (!userId) continue;
    return {
      ownerUserId: userId,
      reason: `渠道路由+池内轮询（${pool === ctx.fourSPool ? '4S池' : '线上池'}）`,
      fromPool: true,
    };
  }
  // ⑥ 老板兜底（老板 username 无账号映射时 owner 留空，由导入侧记「未分配待兜底」）
  return {
    ownerUserId: ctx.userIdByUsername.get(ctx.bossUsername) ?? null,
    reason: '无人接单，老板兜底',
    fromPool: false,
  };
}

/** 分配路由引擎（P3-03）：routeLead 纯函数＋ctx 装配＋落库＋游标推进；到店手工认领与手动改派。
 * route 不抛业务异常（配置缺失/池空走兜底或 owner=null），由导入侧按需记「未分配待兜底」。 */
@Injectable()
export class AssignService {
  private readonly logger = new Logger(AssignService.name);

  constructor(
    private readonly repo: LeadRepository,
    private readonly prisma: PrismaService,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly summary: LeadSummaryTrigger,
    private readonly classify: LeadClassifyTrigger,
  ) {}

  /** 自动分配：装配 ctx → 纯函数 → 落库（ownerUserId/assignedAt/assigned 事件）→ 游标 +1。
   * 传入 tx 时并入调用方事务（导入逐条分配，需看到同批尚未提交的分配结果）。 */
  async route(lead: Lead, tx?: Prisma.TransactionClient): Promise<RouteResult> {
    const client = tx ?? this.prisma;
    // dupOfLeadId/customerId 在导入事务内由 linkIfDuplicate 写回，lead 对象可能过期，重读保一致
    const fresh = await client.lead.findUnique({
      where: { id: lead.id },
      select: { dupOfLeadId: true, customerId: true },
    });
    const dupOfLeadId = fresh?.dupOfLeadId ?? null;
    const ctx = await this.buildContext(tx);
    const input: RouteLeadInput = {
      dupOfLeadId,
      dupOwnerUserId: dupOfLeadId ? await this.resolveOwnerUserId(dupOfLeadId, client) : null,
      sourcePlatform: lead.sourcePlatform,
      acquisitionMethod: lead.acquisitionMethod,
      referralOwnerUserId: fresh?.customerId
        ? await this.resolveReferralOwner(fresh.customerId, client)
        : null,
    };
    const decision = routeLead(input, ctx);
    if (!decision.ownerUserId) {
      return { ownerUserId: null, reason: decision.reason };
    }
    await this.repo.update(
      lead.id,
      { ownerUserId: decision.ownerUserId, assignedAt: new Date() },
      tx,
    );
    await this.repo.appendEvent(
      lead.id,
      LEAD_EVENT_KIND.ASSIGNED,
      { reason: decision.reason },
      undefined,
      tx,
    );
    if (decision.fromPool) {
      await this.writeCursor(ctx.cursor + 1, client);
    }
    return { ownerUserId: decision.ownerUserId, reason: decision.reason };
  }

  /** 到店手工认领：仅 ownerUserId=null 可认领，否则 LEAD_INVALID_STATE（D-P3-6 到店口径）。
   * 条件迁移收口竞态（T5）：两接待人并发认领时只有一个 count=1，后到者 409，先认领者归属不被覆盖。 */
  async claim(leadId: string, actor: JwtPayload): Promise<{ ownerUserId: string }> {
    const lead = await this.repo.findById(leadId);
    if (!lead) throw new AppException(ErrorCode.NOT_FOUND, '客资不存在');
    if (lead.ownerUserId) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, '客资已分配，无法认领');
    }
    const count = await this.repo.updateIfUnclaimed(leadId, {
      ownerUserId: actor.sub,
      assignedAt: new Date(),
    });
    if (count === 0) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, '客资已被他人认领，请刷新');
    }
    await this.repo.appendEvent(
      leadId,
      LEAD_EVENT_KIND.CLAIM,
      { reason: '接待人手工认领' },
      actor.sub,
    );
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'lead.claimed',
      objectType: 'lead',
      objectId: leadId,
      after: { ownerUserId: actor.sub },
    });
    return { ownerUserId: actor.sub };
  }

  /** 手动改派（仅 boss/store_manager）：改派理由必填，写 assigned 事件＋审计。 */
  async assign(
    leadId: string,
    actor: JwtPayload,
    ownerUserId: string,
    reason: string,
  ): Promise<{ ownerUserId: string }> {
    if (!(await this.isGlobal(actor))) {
      throw new AppException(ErrorCode.PERM_DENIED, '仅老板/店长可手动改派');
    }
    const lead = await this.repo.findById(leadId);
    if (!lead) throw new AppException(ErrorCode.NOT_FOUND, '客资不存在');
    // 幂等（2026-08-27 全流程测试 #1）：负责人未变的重复改派（客户端超时重发）直接返回，
    // 不写第二条 assigned 事件、不重复触发 AI（实测曾落两条相同事件）
    if (lead.ownerUserId === ownerUserId) {
      return { ownerUserId };
    }
    await this.repo.update(leadId, { ownerUserId, assignedAt: new Date() });
    await this.repo.appendEvent(
      leadId,
      LEAD_EVENT_KIND.ASSIGNED,
      { reason, source: 'manual' },
      actor.sub,
    );
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'lead.assigned',
      objectType: 'lead',
      objectId: leadId,
      before: { ownerUserId: lead.ownerUserId },
      after: { ownerUserId, reason },
    });
    // P3-05：手动改派为非事务路径，分配成功后触发摘要（幂等）；摘要失败不阻断改派，只记 warn。
    // 2026-08-27 全流程测试 #1：封顶 3 秒（改派接口曾同步等 LLM 32 秒诱发超时重发与重复事件）。
    await withLlmCap(
      (async () => {
        await this.summary.onAssigned(lead);
        await this.classify.onAssigned(lead);
      })(),
    );
    return { ownerUserId };
  }

  /** 系统兜底改派（SLA 升级）：无会话主体，供 SlaService cron 调用；
   * 写 assigned 事件＋审计（actorId 缺省，action 留痕），复用 assign 的落库路径。 */
  async forceAssign(
    leadId: string,
    ownerUserId: string,
    reason: string,
  ): Promise<{ ownerUserId: string }> {
    const lead = await this.repo.findById(leadId);
    if (!lead) throw new AppException(ErrorCode.NOT_FOUND, '客资不存在');
    // 幂等（2026-08-27 全流程测试 #1）：负责人未变的重复改派（客户端超时重发）直接返回，
    // 不写第二条 assigned 事件、不重复触发 AI（实测曾落两条相同事件）
    if (lead.ownerUserId === ownerUserId) {
      return { ownerUserId };
    }
    await this.repo.update(leadId, { ownerUserId, assignedAt: new Date() });
    await this.repo.appendEvent(leadId, LEAD_EVENT_KIND.ASSIGNED, { reason, source: 'sla' });
    await this.audit.record({
      action: 'lead.assigned',
      objectType: 'lead',
      objectId: leadId,
      before: { ownerUserId: lead.ownerUserId },
      after: { ownerUserId, reason, source: 'sla' },
    });
    return { ownerUserId };
  }

  /** 装配 ctx：SystemMeta 池/游标/上限/老板 + 全量用户映射 + 池内各人在跟数 + disabled 集合 */
  private async buildContext(tx?: Prisma.TransactionClient): Promise<RouteContext> {
    const client = tx ?? this.prisma;
    const onlinePool = await this.readStringArray(
      ASSIGN_META_KEYS.onlinePool,
      DEFAULT_ONLINE_POOL,
      client,
    );
    const fourSPool = await this.readStringArray(
      ASSIGN_META_KEYS.fourSPool,
      DEFAULT_FOURS_POOL,
      client,
    );
    const bossUsername = await this.readString(ASSIGN_META_KEYS.boss, DEFAULT_BOSS, client);
    const cursor = await this.readInt(ASSIGN_META_KEYS.cursor, 0, client);
    const maxActive = await this.readInt(ASSIGN_META_KEYS.maxActive, DEFAULT_MAX_ACTIVE, client);

    // 全量用户映射：dup/转介绍负责人可为任意用户，需 userId→username 判 disabled（D-P3-6）
    const allUsers = await client.user.findMany({
      select: { id: true, username: true, disabled: true },
    });
    const userIdByUsername = new Map<string, string>();
    const usernameByUserId = new Map<string, string>();
    const disabled = new Set<string>();
    for (const u of allUsers) {
      userIdByUsername.set(u.username, u.id);
      usernameByUserId.set(u.id, u.username);
      if (u.disabled) disabled.add(u.username);
    }

    const activeCount = new Map<string, number>();
    for (const username of new Set([...onlinePool, ...fourSPool, bossUsername])) {
      const userId = userIdByUsername.get(username);
      if (!userId) continue;
      activeCount.set(username, await this.repo.findActiveCountByOwner(userId, tx));
    }

    return {
      onlinePool,
      fourSPool,
      bossUsername,
      cursor,
      activeCount,
      disabled,
      maxActive,
      userIdByUsername,
      usernameByUserId,
    };
  }

  private async resolveOwnerUserId(
    leadId: string,
    client: Prisma.TransactionClient | PrismaService,
  ) {
    const primary = await client.lead.findUnique({
      where: { id: leadId },
      select: { ownerUserId: true },
    });
    return primary?.ownerUserId ?? null;
  }

  private async resolveReferralOwner(
    customerId: string,
    client: Prisma.TransactionClient | PrismaService,
  ) {
    const customer = await client.customer.findUnique({
      where: { id: customerId },
      select: { sourceReferralOwnerId: true },
    });
    return customer?.sourceReferralOwnerId ?? null;
  }

  private async isGlobal(actor: JwtPayload): Promise<boolean> {
    const user = await this.users.findById(actor.sub);
    return isGlobalRole(user?.userRoles.map((ur) => ur.role.code) ?? []);
  }

  private async readString(
    key: string,
    fallback: string,
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<string> {
    const meta = await client.systemMeta.findUnique({ where: { key } });
    return meta && meta.value ? meta.value : fallback;
  }

  private async readStringArray(
    key: string,
    fallback: string[],
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<string[]> {
    const meta = await client.systemMeta.findUnique({ where: { key } });
    if (!meta) return fallback;
    try {
      const parsed: unknown = JSON.parse(meta.value);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === 'string');
      }
    } catch (err) {
      // 配置损坏 → 回退默认（不阻断分配），但记 warn 保留可观测性（key 不含 PII）
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`assign 配置解析失败，回退默认（key=${key}）：${detail}`);
    }
    return fallback;
  }

  private async readInt(
    key: string,
    fallback: number,
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<number> {
    const meta = await client.systemMeta.findUnique({ where: { key } });
    if (!meta) return fallback;
    const n = Number(meta.value);
    return Number.isInteger(n) ? n : fallback;
  }

  private writeCursor(
    cursor: number,
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<unknown> {
    return client.systemMeta.upsert({
      where: { key: ASSIGN_META_KEYS.cursor },
      create: { key: ASSIGN_META_KEYS.cursor, value: String(cursor) },
      update: { value: String(cursor) },
    });
  }
}
