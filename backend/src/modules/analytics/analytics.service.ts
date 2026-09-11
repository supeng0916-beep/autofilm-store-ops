import { Injectable } from '@nestjs/common';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { JwtPayload } from '../auth/auth.types';
import {
  AnalyticsRepository,
  type LeadFunnel,
  type LostReasonRow,
  type SourceRow,
  type StageCount,
  type TechnicianRow,
} from './analytics.repository';

/** 经营复盘响应 */
export interface AnalyticsOverview {
  range: { from: string | null; to: string | null; scopedToOwner: boolean };
  funnel: LeadFunnel;
  byStage: StageCount[];
  byFinalStatus: StageCount[];
  revenueFen: number;
  avgDealFen: number | null;
  bySource: SourceRow[];
  lostReasons: LostReasonRow[];
  workOrders: {
    total: number;
    delivered: number;
    inProgress: number;
    reworkCount: number;
    reworkRate: number;
    byTechnician: TechnicianRow[];
  };
  /** 财务收支（批次2 T5）：全局口径——流水无 owner，销售视角返回零值（诚实边界，不冒充明细） */
  finance: { incomeFen: number; expenseFen: number; netFen: number };
  /** 毛利估算（批次4）：范围内已录材料成本的已确认订单 Σ(定金+尾款−材料成本)，无符合条件订单为 null。
   * 角色口径同 finance（全局口径）：订单金额属财务数据，销售视角返回 null（诚实边界，不下放） */
  grossProfitFen: number | null;
  /** 内容归因（批次2 T5）：范围内 contentId 非空客资分桶 join 内容台账；无 contentId 不计 */
  contentAttribution: Array<{
    contentId: string;
    title: string | null;
    platform: string | null;
    costFen: number;
    leadCount: number;
    wonCount: number;
    revenueFen: number;
  }>;
  /** 客户画像分布（批次2 T5）：仅统计填写画像的客资 */
  profile: {
    gender: Array<{ value: string; count: number }>;
    ageBand: Array<{ value: string; count: number }>;
  };
  /** 复购客户数（批次6）：范围内成交（finalStatus=won）≥2 条客资的客户数，
   *  按 customerId 分桶；客资无 customerId 不计 */
  repeatCustomerCount: number;
}

/** 经营复盘服务（M10 最小版）：确定性聚合，无 AI 参与（S11）。
 * 口径说明（诚实边界）：
 * - 触达＝firstContactAttemptAt 非空或阶段已推进；到店＝当前阶段 visit_done 或已成交（历史到店无法从快照精确还原）；
 * - 技师产值＝施工单关联客资（leadId）的成交额合计，未关联/未成交不计——近似口径，用于相对比较。
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly repo: AnalyticsRepository) {}

  async overview(actor: JwtPayload, range: { from?: Date; to?: Date }): Promise<AnalyticsOverview> {
    // 数据范围：老板/店长全局；销售/其他业务角色仅本人客资（PERMISSION_MATRIX M10 🔶）
    const roles = await this.repo.userRoleCodes(actor.sub);
    const isGlobal = roles.includes('boss') || roles.includes('store_manager');
    const ownerUserId = isGlobal ? undefined : actor.sub;

    const leads = await this.repo.findLeads(range, ownerUserId);
    const workOrders = await this.repo.findWorkOrders(
      ownerUserId ? leads.map((l) => l.id) : undefined,
    );

    // —— 批次2 T5：财务/内容归因（全局口径）与画像分布（随 leads 的 owner 过滤）；
    //    批次4：订单确认单金额项（毛利估算，同属全局口径） ——
    const [financeEntries, contentRecords, orderConfirmations] = isGlobal
      ? await Promise.all([
          this.repo.findFinanceEntries(range),
          this.repo.findContentRecords(),
          this.repo.findOrderConfirmations(range),
        ])
      : [[], [], []];
    const incomeFen = financeEntries
      .filter((e) => e.direction === 'income')
      .reduce((s, e) => s + e.amountFen, 0);
    const expenseFen = financeEntries
      .filter((e) => e.direction === 'expense')
      .reduce((s, e) => s + e.amountFen, 0);
    // —— 批次4 毛利估算：仅统计已录材料成本的已确认订单；一单都没有则为 null（前端显"—"） ——
    const profitRows = orderConfirmations.filter((o) => o.materialCostFen !== null);
    const grossProfitFen =
      profitRows.length > 0
        ? profitRows.reduce((s, o) => s + o.depositFen + o.balanceFen - (o.materialCostFen ?? 0), 0)
        : null;
    const contentOf = new Map(contentRecords.map((c) => [c.contentKey, c]));
    const attrMap = new Map<string, { leadCount: number; wonCount: number; revenueFen: number }>();
    for (const l of leads) {
      if (!l.contentId) continue;
      const row = attrMap.get(l.contentId) ?? { leadCount: 0, wonCount: 0, revenueFen: 0 };
      row.leadCount += 1;
      if (l.finalStatus === 'won') {
        row.wonCount += 1;
        row.revenueFen += l.closedAmountFen ?? 0;
      }
      attrMap.set(l.contentId, row);
    }
    const contentAttribution = [...attrMap.entries()]
      .map(([contentId, r]) => {
        const c = contentOf.get(contentId);
        return {
          contentId,
          title: c?.title ?? null,
          platform: c?.platform ?? null,
          costFen: c?.costFen ?? 0,
          ...r,
        };
      })
      .sort((a, b) => b.leadCount - a.leadCount);
    const bucket = (values: Array<string | null>): Array<{ value: string; count: number }> => {
      const m = new Map<string, number>();
      for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
      return [...m.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count);
    };

    // —— 漏斗（当前状态近似） ——
    const total = leads.length;
    const touched = leads.filter((l) => l.stage !== 'new' || l.finalStatus !== 'active').length;
    const visited = leads.filter((l) => l.stage === 'visit_done' || l.finalStatus === 'won').length;
    const wonLeads = leads.filter((l) => l.finalStatus === 'won');
    const lost = leads.filter((l) => l.finalStatus === 'lost').length;
    const closeDays = wonLeads
      .filter((l) => l.closedAt)
      .map((l) => (l.closedAt!.getTime() - l.receivedAt.getTime()) / 86_400_000);
    const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : 0);
    const funnel: LeadFunnel = {
      total,
      touched,
      visited,
      won: wonLeads.length,
      lost,
      touchRate: rate(touched, total),
      visitRate: rate(visited, touched),
      closeRate: rate(wonLeads.length, total),
      avgCloseDays:
        closeDays.length > 0
          ? Math.round((closeDays.reduce((a, b) => a + b, 0) / closeDays.length) * 10) / 10
          : null,
    };

    // —— 状态分布 ——
    const groupCount = (items: Array<Record<string, unknown>>, key: string): StageCount[] => {
      const map = new Map<string, number>();
      for (const it of items) {
        const v = it[key];
        const k = typeof v === 'string' && v.length > 0 ? v : 'unknown';
        map.set(k, (map.get(k) ?? 0) + 1);
      }
      return [...map.entries()]
        .map(([stage, count]) => ({ stage, count }))
        .sort((a, b) => b.count - a.count);
    };

    // —— 成交与收入 ——
    const revenueFen = wonLeads.reduce((sum, l) => sum + (l.closedAmountFen ?? 0), 0);

    // —— 来源归因 ——
    const bySourceMap = new Map<string, { total: number; won: number; revenueFen: number }>();
    for (const l of leads) {
      const row = bySourceMap.get(l.sourcePlatform) ?? { total: 0, won: 0, revenueFen: 0 };
      row.total++;
      if (l.finalStatus === 'won') {
        row.won++;
        row.revenueFen += l.closedAmountFen ?? 0;
      }
      bySourceMap.set(l.sourcePlatform, row);
    }

    // —— 流失原因（Top5，未填写归「未记录」） ——
    const lostLeads = leads.filter((l) => l.finalStatus === 'lost');
    const reasonMap = new Map<string, number>();
    for (const l of lostLeads) {
      const r = l.lostReason?.trim() || '未记录';
      reasonMap.set(r, (reasonMap.get(r) ?? 0) + 1);
    }

    // —— 施工产能（技师维度） ——
    const leadRevenue = new Map<string, number>();
    for (const l of wonLeads) leadRevenue.set(l.id, l.closedAmountFen ?? 0);
    const techMap = new Map<string, TechnicianRow>();
    // 产值按（技师 × 客资）去重：同一客资的多张施工单（返工/补录）不重复计产值
    const techCountedLeads = new Map<string, Set<string>>();
    for (const w of workOrders) {
      // 技师关联化（批次3 T3）：分桶键用 ID（精确合并同名/改名），显示名保留姓名；
      // 未关联行（存量未回填）按姓名回退，与 ID 桶天然分开不误并
      const key = w.technicianId ?? w.technicianName?.trim() ?? '未指派';
      const display = w.technicianName?.trim() ?? '未指派';
      const row = techMap.get(key) ?? {
        name: display,
        total: 0,
        delivered: 0,
        rework: 0,
        revenueFen: 0,
      };
      row.total++;
      if (w.stage === 'delivered') row.delivered++;
      if (w.rework) row.rework++;
      if (w.leadId) {
        const counted = techCountedLeads.get(key) ?? new Set<string>();
        if (!counted.has(w.leadId)) {
          row.revenueFen += leadRevenue.get(w.leadId) ?? 0;
          counted.add(w.leadId);
          techCountedLeads.set(key, counted);
        }
      }
      techMap.set(key, row);
    }

    const delivered = workOrders.filter((w) => w.stage === 'delivered').length;
    const reworkCount = workOrders.filter((w) => w.rework).length;

    // —— 复购客户（批次6）：范围内成交客资按 customerId 分桶，计数≥2 的桶数；无 customerId 不计 ——
    const wonByCustomer = new Map<string, number>();
    for (const l of wonLeads) {
      if (!l.customerId) continue;
      wonByCustomer.set(l.customerId, (wonByCustomer.get(l.customerId) ?? 0) + 1);
    }
    const repeatCustomerCount = [...wonByCustomer.values()].filter((c) => c >= 2).length;

    return {
      range: {
        from: range.from?.toISOString() ?? null,
        to: range.to?.toISOString() ?? null,
        scopedToOwner: !isGlobal,
      },
      funnel,
      byStage: groupCount(leads, 'stage'),
      byFinalStatus: groupCount(leads, 'finalStatus'),
      revenueFen,
      avgDealFen: wonLeads.length > 0 ? Math.round(revenueFen / wonLeads.length) : null,
      bySource: [...bySourceMap.entries()]
        .map(([platform, v]) => ({ platform, ...v }))
        .sort((a, b) => b.total - a.total),
      lostReasons: [...reasonMap.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
      workOrders: {
        total: workOrders.length,
        delivered,
        inProgress: workOrders.filter((w) => w.stage === 'in_progress').length,
        reworkCount,
        reworkRate: rate(reworkCount, workOrders.length),
        byTechnician: [...techMap.values()].sort((a, b) => b.total - a.total),
      },
      finance: { incomeFen, expenseFen, netFen: incomeFen - expenseFen },
      grossProfitFen,
      contentAttribution,
      profile: {
        gender: bucket(leads.map((l) => l.gender)),
        ageBand: bucket(leads.map((l) => l.ageBand)),
      },
      repeatCustomerCount,
    };
  }

  /** 查询参数守卫：from < to */
  assertRange(from?: Date, to?: Date): void {
    if (from && to && from >= to) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, '开始时间必须早于结束时间');
    }
  }
}
