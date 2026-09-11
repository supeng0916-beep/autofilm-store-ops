/** 经营复盘（M10 最小版，2026-08-18）：客资漏斗/成交收入/来源归因/流失原因/技师产能。
 * 数据源：leads + work_orders（无新表）；统计口径为「当前状态近似」并在各字段注释说明。
 * 权限：m10:view（老板/店长全局，销售仅本人范围——服务层过滤；记录员无权限）。 */
import { Injectable } from '@nestjs/common';
import type { Lead, WorkOrder } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

/** 漏斗/转化统计（leads 维度，时间窗按 receivedAt） */
export interface LeadFunnel {
  total: number;
  touched: number;
  visited: number;
  won: number;
  lost: number;
  /** 转化率（0-1，分母为 0 时置 0） */
  touchRate: number;
  visitRate: number;
  closeRate: number;
  /** 平均成交周期（天，won 且有 closedAt 才计入） */
  avgCloseDays: number | null;
}

export interface StageCount {
  stage: string;
  count: number;
}

export interface SourceRow {
  platform: string;
  total: number;
  won: number;
  revenueFen: number | null;
}

export interface LostReasonRow {
  reason: string;
  count: number;
}

export interface TechnicianRow {
  name: string;
  total: number;
  delivered: number;
  rework: number;
  /** 产值（分）：该技师施工单关联客资的成交额合计（leadId 缺失/未成交不计，近似口径） */
  revenueFen: number;
}

/** 经营复盘数据访问（S08） */
@Injectable()
export class AnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findLeads(range: { from?: Date; to?: Date }, ownerUserId?: string): Promise<Lead[]> {
    return this.prisma.lead.findMany({
      where: {
        ...(ownerUserId ? { ownerUserId } : {}),
        receivedAt: {
          ...(range.from ? { gte: range.from } : {}),
          ...(range.to ? { lte: range.to } : {}),
        },
      },
      select: {
        id: true,
        customerId: true,
        stage: true,
        finalStatus: true,
        sourcePlatform: true,
        lostReason: true,
        ownerUserId: true,
        receivedAt: true,
        closedAt: true,
        closedAmountFen: true,
        contentId: true,
        gender: true,
        ageBand: true,
      },
    }) as Promise<Lead[]>;
  }

  /** 财务流水（批次2 T5）：范围内按发生日取收支（全局口径——流水无 owner 概念） */
  findFinanceEntries(range: {
    from?: Date;
    to?: Date;
  }): Promise<Array<{ direction: string; amountFen: number; occurredOn: Date }>> {
    return this.prisma.financeEntry.findMany({
      where: {
        occurredOn: {
          ...(range.from ? { gte: range.from } : {}),
          ...(range.to ? { lte: range.to } : {}),
        },
      },
      select: { direction: true, amountFen: true, occurredOn: true },
    });
  }

  /** 内容台账全量（批次2 T5）：小表，归因时 Map 命中 */
  findContentRecords(): Promise<
    Array<{ contentKey: string; title: string; platform: string | null; costFen: number }>
  > {
    return this.prisma.contentRecord.findMany({
      select: { contentKey: true, title: true, platform: true, costFen: true },
    });
  }

  /** 已确认订单确认单金额项（批次4 毛利估算）：时间窗按客户确认时间（customerConfirmedAt）。
   * 只取金额三项+确认时间；materialCostFen 可空（未录成本的单由服务层剔除） */
  findOrderConfirmations(range: { from?: Date; to?: Date }): Promise<
    Array<{
      depositFen: number;
      balanceFen: number;
      materialCostFen: number | null;
      /** confirmed 行必有确认时间；Prisma 类型可空（schema 层为可空列），口径按非空使用 */
      customerConfirmedAt: Date | null;
    }>
  > {
    return this.prisma.orderConfirmation.findMany({
      where: {
        status: 'confirmed',
        customerConfirmedAt: {
          ...(range.from ? { gte: range.from } : {}),
          ...(range.to ? { lte: range.to } : {}),
        },
      },
      select: {
        depositFen: true,
        balanceFen: true,
        materialCostFen: true,
        customerConfirmedAt: true,
      },
    });
  }

  findWorkOrders(leadIds?: string[]): Promise<WorkOrder[]> {
    return this.prisma.workOrder.findMany({
      where: leadIds ? { leadId: { in: leadIds } } : {},
      select: {
        id: true,
        leadId: true,
        technicianName: true,
        technicianId: true,
        stage: true,
        rework: true,
        createdAt: true,
      },
    }) as Promise<WorkOrder[]>;
  }

  /** 用户角色码（销售范围过滤判定） */
  async userRoleCodes(userId: string): Promise<string[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { userRoles: { select: { role: { select: { code: true } } } } },
    });
    return user?.userRoles.map((ur) => ur.role.code) ?? [];
  }
}
