import { Injectable } from '@nestjs/common';

import { AiCostService } from '../../ai-dispatch/ai-cost.service';
import type { JwtPayload } from '../../auth/auth.types';
import { permissionsOf } from '../../auth/permissions';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  BLOCK_ITEM_LIMIT,
  emptyBlock,
  type RoleContextAggregator,
  type StructuredContextBlock,
} from './role-context';

const dayStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayEnd = (d = new Date()) => new Date(dayStart(d).getTime() + 86_399_999);

/** 老板包聚合器（spec §3.3，老板与老板娘共用）：待拍板/待确认订单/AI 水位/跟进到期（原老板娘
 * 职责并入）/录入规范。数据区块按 actor 权限过滤（persona 不放大数据可见范围）。 */
@Injectable()
export class BossAggregator implements RoleContextAggregator {
  readonly persona = 'boss' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cost: AiCostService,
  ) {}

  async collect(actor: JwtPayload): Promise<StructuredContextBlock[]> {
    const [approvals, orders, dueToday, overdue, recentLeads] = await Promise.all([
      this.prisma.approvalItem.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        take: BLOCK_ITEM_LIMIT,
        select: { type: true, payload: true, createdAt: true },
      }),
      this.prisma.orderConfirmation.findMany({
        where: { status: 'draft' },
        orderBy: { createdAt: 'asc' },
        take: BLOCK_ITEM_LIMIT,
        select: { products: true, depositFen: true, balanceFen: true, createdAt: true },
      }),
      this.prisma.lead.findMany({
        where: { finalStatus: 'active', nextFollowUpAt: { gte: dayStart(), lte: dayEnd() } },
        orderBy: [{ intentLevel: 'asc' }, { nextFollowUpAt: 'asc' }],
        take: BLOCK_ITEM_LIMIT,
        select: { leadNo: true, intentLevel: true, nextFollowUpAt: true, ownerUserId: true },
      }),
      this.prisma.lead.findMany({
        where: { finalStatus: 'active', nextFollowUpAt: { lt: new Date() } },
        orderBy: { nextFollowUpAt: 'asc' },
        take: BLOCK_ITEM_LIMIT,
        select: { leadNo: true, intentLevel: true, nextFollowUpAt: true, ownerUserId: true },
      }),
      this.prisma.lead.findMany({
        where: { createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
        select: { leadNo: true, phone: true, wechat: true, target: true, rawNeed: true },
      }),
    ]);

    const blocks: StructuredContextBlock[] = [];

    // approvals：待审批（payload 标题取 title 字段，缺省用 type）
    if (approvals.length === 0) blocks.push(emptyBlock('approvals'));
    else {
      blocks.push({
        key: 'approvals',
        summary: `待审批 ${approvals.length} 项`,
        items: approvals.map((a) => {
          const title = (a.payload as { title?: string } | null)?.title ?? a.type;
          const waitDays = Math.floor((Date.now() - a.createdAt.getTime()) / 86_400_000);
          return `• ${a.type}｜${title}｜等待 ${waitDays} 天`;
        }),
      });
    }

    // orders：草稿态订单（products+定金/尾款概览）
    if (orders.length === 0) blocks.push(emptyBlock('orders'));
    else {
      blocks.push({
        key: 'orders',
        summary: `待确认订单 ${orders.length} 单`,
        items: orders.map(
          (o) =>
            `• ${o.products}｜定金 ¥${(o.depositFen / 100).toFixed(0)}／尾款 ¥${(o.balanceFen / 100).toFixed(0)}｜建单 ${o.createdAt.toLocaleDateString('zh-CN')}`,
        ),
      });
    }

    // aiOps：仅 ai:cost:view（boss 恒有；spec §3.3 权限过滤——无权限的 actor 该区块不注入）
    const roleRows = await this.prisma.userRole.findMany({
      where: { userId: actor.sub },
      select: { role: { select: { code: true } } },
    });
    if (permissionsOf(roleRows.map((r) => r.role.code)).has('ai:cost:view')) {
      const rows = await this.cost.breakdown(1); // 近 1 天（今日），日期×模型×taskType 三维（现有口径）
      const todayFen = rows.reduce((s, r) => s + (r.costFen ?? 0), 0);
      const failing = await this.prisma.aiTask.count({
        where: {
          status: { in: ['failed', 'degraded'] },
          createdAt: { gte: new Date(Date.now() - 86_400_000) },
        },
      });
      blocks.push({
        key: 'aiOps',
        summary: `今日 AI 成本 ¥${(todayFen / 100).toFixed(2)}；近 24h 异常任务 ${failing} 个`,
        items: [],
      });
    }

    // dueToday / overdue：跟进到期（原老板娘职责并入 spec 决策③）
    const ownerIds = [
      ...new Set(
        [...dueToday, ...overdue].map((l) => l.ownerUserId).filter((x): x is string => !!x),
      ),
    ];
    const owners = ownerIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, displayName: true },
        })
      : [];
    const ownerNames = new Map(owners.map((u) => [u.id, u.displayName]));
    if (dueToday.length === 0) blocks.push(emptyBlock('dueToday'));
    else {
      blocks.push({
        key: 'dueToday',
        summary: `今日该跟进 ${dueToday.length} 条客资`,
        items: dueToday.map(
          (l) =>
            `• ${l.leadNo}｜${l.intentLevel} 意向｜负责人 ${ownerNames.get(l.ownerUserId ?? '') ?? '未分配'}｜约定 ${l.nextFollowUpAt?.toLocaleString('zh-CN')}`,
        ),
      });
    }
    if (overdue.length === 0) blocks.push(emptyBlock('overdue'));
    else {
      blocks.push({
        key: 'overdue',
        summary: `已超期未跟进 ${overdue.length} 条`,
        items: overdue.map((l) => {
          const days = Math.floor((Date.now() - (l.nextFollowUpAt?.getTime() ?? 0)) / 86_400_000);
          return `• ${l.leadNo}｜${l.intentLevel} 意向｜超期 ${days} 天｜负责人 ${ownerNames.get(l.ownerUserId ?? '') ?? '未分配'}`;
        }),
      });
    }

    // intakeQuality：近 7 天录入规范扫描（引导补录而非批评，表述由技能侧把握）
    const noContact = recentLeads.filter((l) => !l.phone && !l.wechat);
    const noTarget = recentLeads.filter((l) => !l.target);
    const noRawNeed = recentLeads.filter((l) => !l.rawNeed);
    blocks.push({
      key: 'intakeQuality',
      summary: recentLeads.length
        ? `近 7 天新客资 ${recentLeads.length} 条：缺联系方式 ${noContact.length}、缺车型/对象 ${noTarget.length}、缺需求原话 ${noRawNeed.length}`
        : '暂无数据',
      items: recentLeads.length
        ? [
            ...noContact.slice(0, 3).map((l) => `• ${l.leadNo} 缺联系方式`),
            ...noTarget.slice(0, 3).map((l) => `• ${l.leadNo} 缺车型/对象`),
            ...noRawNeed.slice(0, 3).map((l) => `• ${l.leadNo} 缺需求原话`),
          ].slice(0, BLOCK_ITEM_LIMIT)
        : [],
    });

    return blocks;
  }
}
