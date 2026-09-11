import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/** 接管触发原因 */
export type TakeoverReason =
  | 'high_intent'
  | 'stagnant'
  | 'complex_objection'
  | 'technician_required'
  | 'special_price'
  | 'reputation_risk';

/** 接管优先级：高意向>声誉风险>停滞>复杂异议>特殊价格>指定技师 */
const PRIORITY_ORDER: TakeoverReason[] = [
  'high_intent',
  'reputation_risk',
  'stagnant',
  'complex_objection',
  'special_price',
  'technician_required',
];

const REASON_LABEL: Record<TakeoverReason, string> = {
  high_intent: '高意向',
  reputation_risk: '声誉风险',
  stagnant: '停滞',
  complex_objection: '复杂异议',
  special_price: '特殊价格',
  technician_required: '指定技师',
};

export interface TakeoverCandidate {
  leadId: string;
  leadNo: string;
  customerName: string | null;
  sourcePlatform: string;
  stage: string;
  intentLevel: string;
  ownerName: string | null;
  lastFollowUpAt: string | null;
  reasons: TakeoverReason[];
  priority: number;
}

/** 接管服务（P4-05）：规则引擎识别需老板/店长介入的机会，生成接管队列。
 * 规则为确定性代码（S11），非模型自由判断。 */
@Injectable()
export class TakeoverService {
  constructor(private readonly prisma: PrismaService) {}

  /** 查接管候选队列 */
  async getCandidates(): Promise<TakeoverCandidate[]> {
    // 查所有活跃客资（finalStatus=active，有负责人）
    const leads = await this.prisma.lead.findMany({
      where: { finalStatus: 'active', ownerUserId: { not: null } },
      select: {
        id: true,
        leadNo: true,
        customerName: true,
        sourcePlatform: true,
        stage: true,
        intentLevel: true,
        lastFollowUpAt: true,
        ownerUserId: true,
      },
    });

    const candidates: TakeoverCandidate[] = [];

    for (const lead of leads) {
      const reasons = this.evaluateReasons(lead);
      if (reasons.length === 0) continue;

      const priority = Math.min(...reasons.map((r) => PRIORITY_ORDER.indexOf(r)));
      candidates.push({
        leadId: lead.id,
        leadNo: lead.leadNo,
        customerName: lead.customerName,
        sourcePlatform: lead.sourcePlatform,
        stage: lead.stage,
        intentLevel: lead.intentLevel,
        ownerName: null, // 后续补 owner 信息
        lastFollowUpAt: lead.lastFollowUpAt?.toISOString() ?? null,
        reasons,
        priority,
      });
    }

    // 按优先级排序
    candidates.sort((a, b) => a.priority - b.priority);

    // 补 owner 名称
    const userIds = [
      ...new Set(
        candidates.map((c) => leads.find((l) => l.id === c.leadId)?.ownerUserId).filter(Boolean),
      ),
    ] as string[];
    if (userIds.length > 0) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, displayName: true },
      });
      const nameMap = new Map(users.map((u) => [u.id, u.displayName]));
      for (const c of candidates) {
        const lead = leads.find((l) => l.id === c.leadId);
        if (lead?.ownerUserId) {
          c.ownerName = nameMap.get(lead.ownerUserId) ?? null;
        }
      }
    }

    return candidates;
  }

  /** 规则引擎：评估单条客资的接管触发条件 */
  private evaluateReasons(lead: {
    intentLevel: string;
    stage: string;
    lastFollowUpAt: Date | null;
  }): TakeoverReason[] {
    const reasons: TakeoverReason[] = [];
    const now = new Date();

    // 1. 高意向：intentLevel=high 且尚未到店
    if (
      lead.intentLevel === 'high' &&
      lead.stage !== 'visit_booked' &&
      lead.stage !== 'visit_done'
    ) {
      reasons.push('high_intent');
    }

    // 2. 停滞：7天无跟进
    if (lead.lastFollowUpAt) {
      const daysSinceFollowUp =
        (now.getTime() - lead.lastFollowUpAt.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceFollowUp >= 7) {
        reasons.push('stagnant');
      }
    } else {
      // 从未跟进，按 receivedAt 算
      reasons.push('stagnant'); // 简化：无跟进记录视为停滞
    }

    // 3–6 为占位项：复杂异议/指定技师/特殊价格/声誉风险
    // 这些需要额外的业务标记（opportunity 字段/事件标记），P4-05 V1 暂用占位
    // 后续 P4-06 或 leader 材料到位后细化

    return reasons;
  }

  /** 获取接管原因中文标签 */
  static reasonLabel(reason: TakeoverReason): string {
    return REASON_LABEL[reason];
  }
}
