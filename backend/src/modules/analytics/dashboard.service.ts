import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/** 控制面板待办项 */
export interface DashboardTodo {
  kind: 'sla' | 'approval' | 'follow_up' | 'recheck';
  title: string;
  meta: string;
  /** 前端跳转目标 */
  link: string;
}

export interface DashboardResponse {
  greetingName: string;
  metrics: {
    todayNewLeads: number;
    slaDue: number;
    pendingApprovals: number;
    todayAppointments: number;
    monthRevenueFen: number;
    monthWonCount: number;
  };
  todos: DashboardTodo[];
  scopedToOwner: boolean;
}

/** 控制面板聚合（V2.0 首页真实数据源）：全部确定性查询，无 AI（S11）。
 * 数据范围：老板/店长全局；销售/记录员按本人相关（客资 owner、预约 createdBy、
 * 审批发起人、施工单关联客资 owner）。 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(actor: { sub: string; username: string }): Promise<DashboardResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: actor.sub },
      select: { displayName: true, userRoles: { select: { role: { select: { code: true } } } } },
    });
    const roles = user?.userRoles.map((ur) => ur.role.code) ?? [];
    const isGlobal = roles.includes('boss') || roles.includes('store_manager');
    const owner = isGlobal ? undefined : actor.sub;

    const startToday = this.startOfDay();
    const endToday = new Date(startToday.getTime() + 86_400_000);
    const startMonth = new Date(startToday.getFullYear(), startToday.getMonth(), 1);

    const leadScope = { finalStatus: 'active', ...(owner ? { ownerUserId: owner } : {}) };

    const [todayNewLeads, slaDueLeads, pendingApprovals, todayAppointments, monthWon] =
      await Promise.all([
        this.prisma.lead.count({
          where: { receivedAt: { gte: startToday }, ...(owner ? { ownerUserId: owner } : {}) },
        }),
        // SLA 到期：新客资未触达且时限已过（首触 SLA 口径，P3 SLA 同源）
        this.prisma.lead.findMany({
          where: { ...leadScope, stage: 'new', dueAt: { lte: new Date() } },
          select: { id: true, leadNo: true, customerName: true, dueAt: true },
          orderBy: { dueAt: 'asc' },
          take: 5,
        }),
        this.prisma.approvalItem.findMany({
          where: { status: 'pending', ...(owner ? { requesterId: owner } : {}) },
          select: { id: true, type: true, payload: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
          take: 5,
        }),
        this.prisma.appointment.findMany({
          where: {
            startAt: { gte: startToday, lt: endToday },
            status: { not: 'cancelled' },
            ...(owner ? { createdBy: owner } : {}),
          },
          select: { id: true, serviceItem: true, startAt: true, workbench: true },
          orderBy: { startAt: 'asc' },
          take: 5,
        }),
        this.prisma.lead.findMany({
          where: {
            finalStatus: 'won',
            closedAt: { gte: startMonth },
            ...(owner ? { ownerUserId: owner } : {}),
          },
          select: { closedAmountFen: true },
        }),
      ]);

    // 约定跟进：今天该跟进的活跃客资
    const followUps = await this.prisma.lead.findMany({
      where: {
        ...leadScope,
        nextFollowUpAt: { gte: startToday, lt: endToday },
      },
      select: { id: true, leadNo: true, customerName: true, nextFollowUpAt: true },
      orderBy: { nextFollowUpAt: 'asc' },
      take: 5,
    });

    // 待复检施工单（店长/记录员视角）：WorkOrder.leadId 为裸列（无 Prisma 关系），
    // 非全局角色按本人客资 id 集过滤（work-order.service ownLeadIds 同构谓词）
    const recheckScope = owner ? { leadId: { in: await this.ownLeadIds(owner) } } : {};
    const rechecks = await this.prisma.workOrder.findMany({
      where: {
        stage: 'self_check_done',
        ...recheckScope,
      },
      select: { id: true, orderNo: true, technicianName: true },
      orderBy: { updatedAt: 'asc' },
      take: 5,
    });

    const todos: DashboardTodo[] = [
      ...slaDueLeads.map((l) => ({
        kind: 'sla' as const,
        title: `${l.leadNo} ${l.customerName ?? '未留名客资'} 待首次触达`,
        meta: `时限 ${this.fmtTime(l.dueAt)}`,
        link: `/leads/${l.id}`,
      })),
      ...pendingApprovals.map((a) => ({
        kind: 'approval' as const,
        title: `审批：${this.approvalTitle(a.type, a.payload as Record<string, unknown>)}`,
        meta: `发起于 ${this.fmtTime(a.createdAt)}`,
        link: '/approvals',
      })),
      ...followUps.map((l) => ({
        kind: 'follow_up' as const,
        title: `${l.leadNo} ${l.customerName ?? ''} 约定跟进`,
        meta: `时间 ${this.fmtTime(l.nextFollowUpAt)}`,
        link: `/leads/${l.id}`,
      })),
      ...rechecks.map((w) => ({
        kind: 'recheck' as const,
        title: `${w.orderNo} 待复检${w.technicianName ? `（${w.technicianName}）` : ''}`,
        meta: '店长复检节点',
        link: '/work-orders',
      })),
    ];

    return {
      greetingName: user?.displayName ?? actor.username,
      metrics: {
        todayNewLeads,
        slaDue: slaDueLeads.length,
        pendingApprovals: pendingApprovals.length,
        todayAppointments: todayAppointments.length,
        monthRevenueFen: monthWon.reduce((s, l) => s + (l.closedAmountFen ?? 0), 0),
        monthWonCount: monthWon.length,
      },
      todos,
      scopedToOwner: !isGlobal,
    };
  }

  private startOfDay(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /** 用户负责的客资 ID 集（sales 视野过滤；work-order.repository ownLeadIds 同构） */
  private async ownLeadIds(userId: string): Promise<string[]> {
    const leads = await this.prisma.lead.findMany({
      where: { ownerUserId: userId },
      select: { id: true },
    });
    return leads.map((l) => l.id);
  }

  private fmtTime(d: Date | null): string {
    return d
      ? d.toLocaleString('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '-';
  }

  /** 审批项标题：按类型的可读摘要 */
  private approvalTitle(type: string, payload: Record<string, unknown>): string {
    const summary = typeof payload.summary === 'string' ? payload.summary : '';
    if (type === 'm07.schedule.confirm') return summary || '排期确认';
    if (type === 'knowledge.activate') {
      const title = typeof payload.title === 'string' ? payload.title : '知识条目';
      return `价格生效：${title}`;
    }
    return summary || type;
  }
}
