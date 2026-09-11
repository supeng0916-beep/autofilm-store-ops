import { Injectable } from '@nestjs/common';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../auth/auth.types';
import {
  REWARD_COMPARATORS,
  REWARD_DIRECTIONS,
  REWARD_METRICS,
  type RewardMetric,
} from './reward-rule.constants';

/** 奖惩规则服务（批次3）：系统只算账——规则 CRUD（boss∪sys_admin）+ 按月事实求值出草案 +
 * 人工确认落 StaffRecord（幂等键防同月同人同规则重复确认）。指标口径与 analytics.byTechnician
 * 同源（按 work_orders.technicianName 聚合：交付=delivered、返工=rework、产值=关联客资成交额）。 */
@Injectable()
export class RewardRuleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 门禁：boss ∪ sys_admin（沿 persona-map/ai-cost 提额先例） */
  private async assertBossOrAdmin(actor: JwtPayload): Promise<void> {
    const roles = await this.prisma.userRole.findMany({
      where: { userId: actor.sub },
      select: { role: { select: { code: true } } },
    });
    const codes = roles.map((r) => r.role.code);
    if (!codes.includes('boss') && !codes.includes('sys_admin')) {
      throw new AppException(ErrorCode.PERM_DENIED, '仅老板或系统管理员可管理奖惩规则');
    }
  }

  list(actor: JwtPayload) {
    return this.assertBossOrAdmin(actor).then(() =>
      this.prisma.rewardRule.findMany({ orderBy: { createdAt: 'desc' } }),
    );
  }

  async create(
    actor: JwtPayload,
    dto: {
      name: string;
      metric: string;
      comparator: string;
      threshold: number;
      direction: string;
      amountFen: number;
    },
  ) {
    await this.assertBossOrAdmin(actor);
    const rule = await this.prisma.rewardRule.create({
      data: { ...dto, createdBy: actor.sub },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'reward_rule.created',
      objectType: 'reward_rule',
      objectId: rule.id,
      after: { name: rule.name, metric: rule.metric, amountFen: rule.amountFen },
    });
    return rule;
  }

  async update(
    actor: JwtPayload,
    id: string,
    dto: { name?: string; threshold?: number; amountFen?: number; enabled?: boolean },
  ) {
    await this.assertBossOrAdmin(actor);
    const before = await this.prisma.rewardRule.findUnique({ where: { id } });
    if (!before) throw new AppException(ErrorCode.NOT_FOUND, '规则不存在');
    const rule = await this.prisma.rewardRule.update({ where: { id }, data: dto });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'reward_rule.updated',
      objectType: 'reward_rule',
      objectId: id,
      before: { enabled: before.enabled, threshold: before.threshold },
      after: { enabled: rule.enabled, threshold: rule.threshold },
    });
    return rule;
  }

  /** 按月事实求值：每技师×每启用规则，命中即草案（草案不入库——确认才落 StaffRecord） */
  async preview(
    actor: JwtPayload,
    month: string,
  ): Promise<
    Array<{
      ruleId: string;
      ruleName: string;
      technicianName: string;
      metric: RewardMetric;
      metricValue: number;
      direction: string;
      amountFen: number;
      alreadyConfirmed: boolean;
    }>
  > {
    await this.assertBossOrAdmin(actor);
    const confirmed = await this.confirmedKeys(month);
    const [rules, facts] = await Promise.all([
      this.prisma.rewardRule.findMany({ where: { enabled: true } }),
      this.monthlyFacts(month),
    ]);
    const drafts: Array<{
      ruleId: string;
      ruleName: string;
      technicianName: string;
      metric: RewardMetric;
      metricValue: number;
      direction: string;
      amountFen: number;
      alreadyConfirmed: boolean;
    }> = [];
    for (const rule of rules) {
      for (const [name, fact] of facts) {
        const value = fact[rule.metric as RewardMetric] ?? 0;
        const hit = rule.comparator === 'gte' ? value >= rule.threshold : value <= rule.threshold;
        if (!hit) continue;
        drafts.push({
          ruleId: rule.id,
          ruleName: rule.name,
          technicianName: name,
          metric: rule.metric as RewardMetric,
          metricValue: value,
          direction: rule.direction,
          amountFen: rule.amountFen,
          alreadyConfirmed: confirmed.has(`${rule.id}:${name}`),
        });
      }
    }
    return drafts;
  }

  /** 人工确认（老板拍板）：写 StaffRecord（subjectType=technician）+ 审计 + 幂等键登记 */
  async confirm(
    actor: JwtPayload,
    dto: {
      month: string;
      items: Array<{
        ruleId: string;
        technicianName: string;
        metricValue: number;
        amountFen: number;
        direction: string;
        note?: string;
      }>;
    },
  ) {
    await this.assertBossOrAdmin(actor);
    const confirmed = await this.confirmedKeys(dto.month);
    const created: string[] = [];
    for (const item of dto.items) {
      const rule = await this.prisma.rewardRule.findUnique({ where: { id: item.ruleId } });
      if (!rule) throw new AppException(ErrorCode.NOT_FOUND, `规则 ${item.ruleId} 不存在`);
      const key = `${item.ruleId}:${item.technicianName}`;
      if (confirmed.has(key)) continue; // 同月同人同规则幂等跳过
      const record = await this.prisma.staffRecord.create({
        data: {
          subjectType: 'technician',
          subjectId: item.technicianName,
          kind: item.direction,
          content: `${dto.month} ${rule.name}（指标值 ${item.metricValue}）${
            item.note ? `｜${item.note}` : ''
          }`,
          occurredAt: new Date(`${dto.month}-01T00:00:00`),
          recordedBy: actor.sub,
        },
      });
      created.push(record.id);
      confirmed.add(key);
    }
    // 幂等键回写（宁漏记不重发：先写记录后记键，键写失败最多提示重复提交）
    await this.prisma.systemMeta.upsert({
      where: { key: `reward.confirmed.${dto.month}` },
      create: { key: `reward.confirmed.${dto.month}`, value: JSON.stringify([...confirmed]) },
      update: { value: JSON.stringify([...confirmed]) },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'reward_rule.confirmed',
      objectType: 'reward_confirmation',
      objectId: dto.month,
      after: { count: created.length },
    });
    return { created: created.length };
  }

  private async confirmedKeys(month: string): Promise<Set<string>> {
    const meta = await this.prisma.systemMeta.findUnique({
      where: { key: `reward.confirmed.${month}` },
    });
    if (!meta) return new Set();
    try {
      return new Set(JSON.parse(meta.value) as string[]);
    } catch {
      return new Set();
    }
  }

  /** 月度事实（口径=analytics.byTechnician 同源）：按工单技师姓名聚合 */
  private async monthlyFacts(month: string): Promise<Map<string, Record<RewardMetric, number>>> {
    const start = new Date(`${month}-01T00:00:00`);
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);
    const rows = await this.prisma.workOrder.findMany({
      where: { createdAt: { gte: start, lt: end } },
      select: { technicianName: true, stage: true, rework: true, leadId: true },
    });
    // WorkOrder.leadId 为裸列（无 relation）：两步查成交客资金额（口径=analytics.byTechnician 同源）
    const leadIds = [...new Set(rows.map((r) => r.leadId).filter((x): x is string => !!x))];
    const wonLeads = leadIds.length
      ? await this.prisma.lead.findMany({
          where: { id: { in: leadIds }, finalStatus: 'won' },
          select: { id: true, closedAmountFen: true },
        })
      : [];
    const wonFenOf = new Map(wonLeads.map((l) => [l.id, l.closedAmountFen ?? 0]));
    const facts = new Map<string, Record<RewardMetric, number>>();
    for (const r of rows) {
      const name = r.technicianName?.trim();
      if (!name) continue;
      const fact = facts.get(name) ?? { delivered_count: 0, rework_count: 0, revenue_fen: 0 };
      if (r.stage === 'delivered') fact.delivered_count += 1;
      if (r.rework) fact.rework_count += 1;
      if (r.leadId) fact.revenue_fen += wonFenOf.get(r.leadId) ?? 0;
      facts.set(name, fact);
    }
    return facts;
  }
}

void REWARD_METRICS;
void REWARD_COMPARATORS;
void REWARD_DIRECTIONS;
