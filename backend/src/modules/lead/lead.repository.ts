import { Injectable } from '@nestjs/common';
import type { Customer, Lead, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { LeadEventKind } from './lead.constants';
import { normalizePhone, normalizeWechat } from './lead.normalize';

/** 客资编号唯一冲突重试上限（P2002 识别，D-P3-1） */
const LEAD_NO_RETRY_MAX = 3;

/** 导入批次创建入参（lead_import 专用，独立于客资主域方法） */
export interface ImportBatchCreateData {
  kind: string;
  fileName: string;
  fileHash: string;
  rowCount: number;
  dupCount: number;
  operatorId: string;
  summary: Record<string, unknown>;
}

/** 队列查询过滤（GET /leads 用；scope 由服务层解析后传入，本方法不感知角色）。
 * 2026-08-28 bug1：负责人过滤由服务层把姓名解析成 ownerIds 传入（不再接受原始用户 ID）。 */
export interface LeadListFilters {
  stage?: string;
  finalStatus?: string;
  ownerIds?: string[];
  keyword?: string;
}

/** 数据范围：ownerUserId 存在＝仅本人（sales_ops）；缺省＝全局（boss/store_manager） */
export interface LeadScope {
  ownerUserId?: string;
}

/** 客资数据访问（S08：controller 不直接调 Prisma）。
 * Task 3 建 create/findById/appendEvent＋导入批次；Task 6 增去重/合并所需：
 * findFirstActiveByContact/update/findOrCreateCustomer/updateBatchDupCount；
 * T5 增复购兜底匹配：findPrimaryByContact（active 优先，won/lost 兜底）；
 * Task 7 增队列/分配所需：findManyByScope/findActiveCountByOwner/findUserIdByUsername。
 * updateIfStatus(Task 9 留档) 已由 T5 补齐为 updateIfFinalStatus/updateIfUnclaimed。 */
@Injectable()
export class LeadRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 创建客资：生成 leadNo（L-YYYYMMDD-NNNN 当日序号），唯一冲突重试 ≤3 次。
   * 传 tx 时并入调用方事务；否则每次插入各自原子（并发冲突经重试恢复）。 */
  async create(
    data: Omit<Prisma.LeadUncheckedCreateInput, 'leadNo'>,
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? this.prisma;
    const prefix = leadNoPrefix(new Date());
    let lastError: unknown;
    for (let attempt = 0; attempt < LEAD_NO_RETRY_MAX; attempt++) {
      const count = await client.lead.count({ where: { leadNo: { startsWith: prefix } } });
      const leadNo = `${prefix}${String(count + 1).padStart(4, '0')}`;
      try {
        return await client.lead.create({ data: { ...data, leadNo } });
      } catch (err) {
        lastError = err;
        if (isUniqueConstraintError(err)) continue;
        throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('生成客资编号失败');
  }

  findById(id: string): Promise<Lead | null> {
    return this.prisma.lead.findUnique({ where: { id }, include: { customer: true } });
  }

  /** 按上游派发NO精确匹配（金山反馈表回填定位；upstreamDispatchNo 非唯一，取首条） */
  findByDispatchNo(no: string): Promise<Lead | null> {
    return this.prisma.lead.findFirst({ where: { upstreamDispatchNo: no } });
  }

  /** 金山反馈回填：仅更新 hqFeedbackStatus / closedAmountFen（不改 finalStatus/stage） */
  updateKingsoftFeedback(
    leadId: string,
    data: { hqFeedbackStatus?: string; closedAmountFen?: number },
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? this.prisma;
    return client.lead.update({ where: { id: leadId }, data });
  }

  /** 写互动流水：只增不改（lead_events 时间线事实源） */
  appendEvent(
    leadId: string,
    kind: LeadEventKind,
    content?: Record<string, unknown>,
    operatorId?: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? this.prisma;
    return client.leadEvent.create({
      data: {
        leadId,
        kind,
        operatorId,
        content: content === undefined ? undefined : (content as Prisma.InputJsonValue),
      },
    });
  }

  /** 按归一化联系方式找首个活跃主客资（dupOfLeadId 为空、finalStatus=active）。
   * 应用层过滤：V1 候选量小，拉回 phone/wechat 非空候选后 normalize 比对，
   * 不在 DB 侧用 replace() 表达式做归一化匹配（去重键口径见 lead.normalize.ts）。
   * excludeId 排除刚创建待判重的 Lead 自身；tx 供导入事务内读（需看到同批未提交 Lead）。 */
  findFirstActiveByContact(
    phone: string | null,
    wechat: string | null,
    excludeId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Lead | null> {
    return this.findFirstByContactAndStatuses(phone, wechat, ['active'], excludeId, tx);
  }

  /** 两级匹配找挂链目标主客资（T5 扩展，复购/回访场景）：
   * 第一级 finalStatus=active（既有行为，优先级不变）；无命中再兜底 won/lost——
   * 主客资成交/战败后同联系方式再派发（回访、复购）时仍挂链，让新客资沿用既有 customerId，
   * 复购统计（repeatCustomerCount 按 customerId 分桶成交≥2）不漏算。
   * 两级均要求 dupOfLeadId 为空（主客资）、createdAt asc 取最早。 */
  async findPrimaryByContact(
    phone: string | null,
    wechat: string | null,
    excludeId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Lead | null> {
    const active = await this.findFirstByContactAndStatuses(
      phone,
      wechat,
      ['active'],
      excludeId,
      tx,
    );
    if (active) return active;
    return this.findFirstByContactAndStatuses(phone, wechat, ['won', 'lost'], excludeId, tx);
  }

  /** 按 finalStatus 集合 + 归一化联系方式找最早主客资（上面两方法的共用实现）。 */
  private async findFirstByContactAndStatuses(
    phone: string | null,
    wechat: string | null,
    finalStatuses: string[],
    excludeId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Lead | null> {
    const client = tx ?? this.prisma;
    const or: Prisma.LeadWhereInput[] = [];
    if (phone) or.push({ phone: { not: null } });
    if (wechat) or.push({ wechat: { not: null } });
    if (or.length === 0) return null;
    const candidates = await client.lead.findMany({
      where: {
        OR: or,
        finalStatus: { in: finalStatuses },
        dupOfLeadId: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const c of candidates) {
      if (phone && c.phone && normalizePhone(c.phone) === phone) return c;
      if (wechat && c.wechat && normalizeWechat(c.wechat) === wechat) return c;
    }
    return null;
  }

  /** 更新客资（只允许更新 dupOfLeadId/customerId 等标量；无 update 之外的删除方法） */
  update(id: string, data: Prisma.LeadUncheckedUpdateInput, tx?: Prisma.TransactionClient) {
    const client = tx ?? this.prisma;
    return client.lead.update({ where: { id }, data });
  }

  /** 阶段条件迁移：仅当当前 stage 为 from 时更新，返回受影响行数（P3-04 防并发竞态）。
   * count=0 表示客资已离开 from 态（被并发推进/复活），由服务层抛 LEAD_INVALID_STATE。 */
  async updateIfStage(
    leadId: string,
    from: string,
    data: Prisma.LeadUncheckedUpdateInput,
  ): Promise<number> {
    const result = await this.prisma.lead.updateMany({ where: { id: leadId, stage: from }, data });
    return result.count;
  }

  /** 沉默档条件迁移：仅当当前 silenceStage 为 from 且仍 active 时更新（防复活竞态） */
  async updateIfSilenceStage(
    leadId: string,
    from: string,
    data: Prisma.LeadUncheckedUpdateInput,
  ): Promise<number> {
    const result = await this.prisma.lead.updateMany({
      where: { id: leadId, silenceStage: from, finalStatus: 'active' },
      data,
    });
    return result.count;
  }

  /** 终态条件迁移（Task 9 留档项，T5 补齐）：仅当 finalStatus 仍在 from 集合内才更新。
   * count=0 表示客资已离开前置态（被并发成交/流失/无效/重开），由调用方按语义抛 409 或幂等跳过。
   * 成交/无效/提议流失/流失决定回写/重开等单向迁移统一走此方法收口竞态窗口。 */
  async updateIfFinalStatus(
    leadId: string,
    from: string[],
    data: Prisma.LeadUncheckedUpdateInput,
  ): Promise<number> {
    const result = await this.prisma.lead.updateMany({
      where: { id: leadId, finalStatus: { in: from } },
      data,
    });
    return result.count;
  }

  /** 认领条件迁移（T5）：仅当 ownerUserId 仍为空（未分配）时生效——
   * 两接待人并发认领同一到店客资时只有一个成功，后到者 count=0 抛 LEAD_INVALID_STATE。 */
  async updateIfUnclaimed(leadId: string, data: Prisma.LeadUncheckedUpdateInput): Promise<number> {
    const result = await this.prisma.lead.updateMany({
      where: { id: leadId, ownerUserId: null },
      data,
    });
    return result.count;
  }

  /** 销售机会：按 leadId 唯一查询（懒创建判存在） */
  findOpportunityByLeadId(leadId: string) {
    return this.prisma.opportunity.findUnique({ where: { leadId } });
  }

  createOpportunity(data: Prisma.OpportunityUncheckedCreateInput) {
    return this.prisma.opportunity.create({ data });
  }

  updateOpportunity(id: string, data: Prisma.OpportunityUncheckedUpdateInput) {
    return this.prisma.opportunity.update({ where: { id }, data });
  }

  /** 沉默链候选（P3-04）：未暂停且 finalStatus 为 active（升档）或 silence（14d 流失提醒）；
   * 最后联系时间由服务层取 firstCustomerReplyAt/lastFollowUpAt 较大者。 */
  findSilenceCandidates() {
    return this.prisma.lead.findMany({
      where: { finalStatus: { in: ['active', 'silence'] }, pausedAt: null },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** 客户主档：按归一化电话/微信查已有 Customer，无则建（客户唯一事实源，去重/合并统一 customerId）。
   * phone 落库为归一化值（Customer.phone NOT NULL，微信-only 客资落空串，仅作占位不参与匹配）。 */
  async findOrCreateCustomer(
    input: { name: string; phone?: string | null; wechat?: string | null },
    tx?: Prisma.TransactionClient,
  ): Promise<Customer> {
    const client = tx ?? this.prisma;
    const phone = input.phone ? normalizePhone(input.phone) : null;
    const wechat = input.wechat ? normalizeWechat(input.wechat) : null;
    if (phone || wechat) {
      const or: Prisma.CustomerWhereInput[] = [];
      if (phone) or.push({ phone: { not: '' } });
      if (wechat) or.push({ wechat: { not: null } });
      const candidates = await client.customer.findMany({
        where: { OR: or },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      for (const c of candidates) {
        if (phone && c.phone && normalizePhone(c.phone) === phone) return c;
        if (wechat && c.wechat && normalizeWechat(c.wechat) === wechat) return c;
      }
    }
    return client.customer.create({
      data: {
        name: input.name || '未命名客户',
        phone: phone ?? input.phone ?? '',
        wechat: input.wechat ?? null,
      },
    });
  }

  /** 导入批次去重计数回填：dupCount 列 + summary.dupCount（去重发生在建批之后逐行判重） */
  async updateBatchDupCount(batchId: string, dupCount: number, tx?: Prisma.TransactionClient) {
    const client = tx ?? this.prisma;
    const batch = await client.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    const summary = (batch.summary ?? {}) as Record<string, unknown>;
    return client.importBatch.update({
      where: { id: batchId },
      data: { dupCount, summary: { ...summary, dupCount } },
    });
  }

  /** 文件指纹查重：已导入过（同 fileHash 存在 ImportBatch）即命中 */
  findBatchByHash(fileHash: string) {
    return this.prisma.importBatch.findFirst({ where: { fileHash } });
  }

  createBatch(data: ImportBatchCreateData, tx?: Prisma.TransactionClient) {
    const client = tx ?? this.prisma;
    return client.importBatch.create({
      data: { ...data, summary: data.summary as Prisma.InputJsonValue },
    });
  }

  /** 队列查询（GET /leads）：scope 强制数据范围（sales_ops 仅本人，全局不过滤）；
   * 全局角色可叠加 stage/finalStatus/ownerIds/keyword 过滤。返回含 customer（chatLink 过滤在服务层）。 */
  findManyByScope(scope: LeadScope, filters: LeadListFilters = {}): Promise<Lead[]> {
    const where: Prisma.LeadWhereInput = {};
    if (scope.ownerUserId) where.ownerUserId = scope.ownerUserId;
    if (filters.stage) where.stage = filters.stage;
    if (filters.finalStatus) where.finalStatus = filters.finalStatus;
    if (filters.ownerIds) where.ownerUserId = { in: filters.ownerIds };
    if (filters.keyword) {
      where.OR = [
        { customerName: { contains: filters.keyword } },
        { phone: { contains: filters.keyword } },
        { wechat: { contains: filters.keyword } },
        { leadNo: { contains: filters.keyword } },
      ];
    }
    return this.prisma.lead.findMany({
      where,
      include: { customer: true },
      orderBy: [{ receivedAt: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /** SLA 候选（D-P3-5）：活跃、新线索、首次触达未完成、未暂停（P3-04 暂停期跳过）；
   * 非到店过滤在服务层（应用层 contains 判定）。 */
  findSlaCandidates(): Promise<Lead[]> {
    return this.prisma.lead.findMany({
      where: { finalStatus: 'active', stage: 'new', firstContactAttemptAt: null, pausedAt: null },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** 时间线：某客资全部事件倒序（GET /leads/:id/events，P3-06 详情页时间线） */
  findEventsByLead(leadId: string) {
    return this.prisma.leadEvent.findMany({
      where: { leadId },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    });
  }

  /** 某客资指定 kind 事件（草稿历史/版本计数用；正序便于计数） */
  findEventsByLeadAndKind(leadId: string, kind: LeadEventKind) {
    return this.prisma.leadEvent.findMany({
      where: { leadId, kind },
      orderBy: { occurredAt: 'asc' },
    });
  }

  /** 事件去重查询：同 lead 同 kind 是否已存在（SLA 三级事件幂等） */
  async eventExists(leadId: string, kind: LeadEventKind): Promise<boolean> {
    const event = await this.prisma.leadEvent.findFirst({
      where: { leadId, kind },
      select: { id: true },
    });
    return event !== null;
  }

  /** 在跟数＝该 owner 名下 finalStatus=active 且 stage≠visit_done 的 Lead 数（D-P3-6 轮询上限口径）。
   * tx 供导入事务内统计（需看到同批尚未提交的分配结果）。 */
  async findActiveCountByOwner(
    ownerUserId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? this.prisma;
    return client.lead.count({
      where: { ownerUserId, finalStatus: 'active', stage: { not: 'visit_done' } },
    });
  }

  /** username → userId（分配池配置以 username 存储，落库前解析为 userId） */
  async findUserIdByUsername(username: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    return user?.id ?? null;
  }
}

/** 当日 leadNo 前缀：L-YYYYMMDD- */
function leadNoPrefix(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `L-${y}${m}${d}-`;
}

/** Prisma 唯一约束冲突识别（P2002），不依赖 @prisma/client 具体错误类 */
function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}
