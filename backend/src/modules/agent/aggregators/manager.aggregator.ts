import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';
import type { JwtPayload } from '../../auth/auth.types';
import {
  BLOCK_ITEM_LIMIT,
  emptyBlock,
  type RoleContextAggregator,
  type StructuredContextBlock,
} from './role-context';

const dayStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayEnd = (d = new Date()) => new Date(dayStart(d).getTime() + 86_399_999);

/** 店长包聚合器（spec §3.3）：今日/明日待确认预约、技师变更、施工中工单与负载。
 * 负载口径同 analytics.byTechnician：按 work_orders.technicianName 姓名匹配聚合（V1）。 */
@Injectable()
export class ManagerAggregator implements RoleContextAggregator {
  readonly persona = 'manager' as const;

  constructor(private readonly prisma: PrismaService) {}

  async collect(_actor: JwtPayload): Promise<StructuredContextBlock[]> {
    void _actor; // 接口统一带 actor（boss 包权限过滤用）；店长包区块无权限敏感数据
    const windowEnd = new Date(dayEnd().getTime() + 86_400_000); // 今明两天
    const [appointments, techChanges, workOrders] = await Promise.all([
      this.prisma.appointment.findMany({
        where: { status: 'pending', startAt: { gte: dayStart(), lte: windowEnd } },
        orderBy: { startAt: 'asc' },
        take: BLOCK_ITEM_LIMIT,
        select: { serviceItem: true, startAt: true, technicianName: true },
      }),
      this.prisma.appointmentTechnicianChange.findMany({
        where: { status: 'pending' },
        orderBy: { requestedAt: 'asc' },
        take: BLOCK_ITEM_LIMIT,
        select: { fromName: true, toName: true, reason: true },
      }),
      this.prisma.workOrder.findMany({
        where: { stage: 'in_progress' },
        orderBy: { createdAt: 'asc' },
        take: BLOCK_ITEM_LIMIT,
        select: { orderNo: true, technicianName: true, stage: true },
      }),
    ]);

    const blocks: StructuredContextBlock[] = [];

    blocks.push(
      appointments.length === 0
        ? emptyBlock('appointments')
        : {
            key: 'appointments',
            summary: `今明两天待确认预约 ${appointments.length} 个`,
            items: appointments.map(
              (a) =>
                `• ${a.startAt.toLocaleString('zh-CN')}｜${a.serviceItem ?? '未填项目'}｜技师 ${a.technicianName ?? '未指定'}`,
            ),
          },
    );

    blocks.push(
      techChanges.length === 0
        ? emptyBlock('techChanges')
        : {
            key: 'techChanges',
            summary: `待客户确认的技师变更 ${techChanges.length} 个`,
            items: techChanges.map(
              (c) => `• ${c.fromName} → ${c.toName}｜原因：${c.reason ?? '未填'}`,
            ),
          },
    );

    blocks.push(
      workOrders.length === 0
        ? emptyBlock('workOrders')
        : {
            key: 'workOrders',
            summary: `施工中工单 ${workOrders.length} 张`,
            items: workOrders.map(
              (w) => `• ${w.orderNo}｜${w.stage}｜技师 ${w.technicianName ?? '未指派'}`,
            ),
          },
    );

    // load：技师人均在手工单（冲突排查视角：同名技师单量堆积=时间重叠风险）
    const byTech = new Map<string, number>();
    for (const w of workOrders) {
      const name = w.technicianName ?? '未指派';
      byTech.set(name, (byTech.get(name) ?? 0) + 1);
    }
    blocks.push(
      byTech.size === 0
        ? emptyBlock('load')
        : {
            key: 'load',
            summary: `技师负载：${[...byTech.entries()].map(([n, c]) => `${n} ${c} 单`).join('、')}`,
            items: [],
          },
    );

    return blocks;
  }
}
