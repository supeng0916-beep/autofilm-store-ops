import { Injectable } from '@nestjs/common';
import type { OrderConfirmation, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ORDER_STATUS } from './order.states';

/** 欠款清单行（批次5 Task 5）：确认单最小金额列 + 客资称呼/电话。
 * schema 未建 OrderConfirmation→Lead 关系（仅 leadId 裸列），无法 include，
 * 客资信息二次查询后内存合并；lead 缺失（悬空）时称呼/电话为 null。 */
export interface ArrearsRow {
  id: string;
  leadId: string;
  depositFen: number;
  balanceFen: number;
  customerConfirmedAt: Date;
  customerName: string | null;
  phone: string | null;
}

/** 订单确认单数据访问（批次1 Task 7；S08：controller 不直接调 Prisma）。
 * leadId @unique 冲突（P2002）由服务层捕获转业务 409。 */
@Injectable()
export class OrderConfirmationRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.OrderConfirmationUncheckedCreateInput): Promise<OrderConfirmation> {
    return this.prisma.orderConfirmation.create({ data });
  }

  findById(id: string): Promise<OrderConfirmation | null> {
    return this.prisma.orderConfirmation.findUnique({ where: { id } });
  }

  /** 列表：可选按客资过滤；createdAt desc = 新单在前 */
  findMany(leadId?: string): Promise<OrderConfirmation[]> {
    return this.prisma.orderConfirmation.findMany({
      where: leadId ? { leadId } : {},
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 欠款提醒（批次5 Task 5）：confirmed 且尾款>0 的确认单清单。
   * 排序按客户确认时间升序——欠得最久的排最前，便于财务催收。
   * 客资称呼/电话按 leadId 批量查最小列后合并（lead 悬空时两字段为 null，容错）。 */
  async findArrears(): Promise<ArrearsRow[]> {
    const rows = await this.prisma.orderConfirmation.findMany({
      where: { status: ORDER_STATUS.CONFIRMED, balanceFen: { gt: 0 } },
      orderBy: { customerConfirmedAt: 'asc' },
    });
    const leads = await this.prisma.lead.findMany({
      where: { id: { in: rows.map((r) => r.leadId) } },
      select: { id: true, customerName: true, phone: true },
    });
    const leadMap = new Map(leads.map((l) => [l.id, l]));
    return rows.map((r) => {
      const lead = leadMap.get(r.leadId);
      return {
        id: r.id,
        leadId: r.leadId,
        depositFen: r.depositFen,
        balanceFen: r.balanceFen,
        // confirmed 态必有确认时间（confirm 条件更新同事务落库，服务层口径）
        customerConfirmedAt: r.customerConfirmedAt!,
        customerName: lead?.customerName ?? null,
        phone: lead?.phone ?? null,
      };
    });
  }

  /** 客资终态查询（创建前置：订单确认只能挂已成交客资，lead-lifecycle.confirmWon 口径） */
  findLeadFinalStatus(id: string): Promise<{ finalStatus: string } | null> {
    return this.prisma.lead.findUnique({ where: { id }, select: { finalStatus: true } });
  }

  /** 条件客户确认：仅 draft 可置 confirmed（终态防重，并发/重复操作返回 0）。
   * updateMany 返回 BatchPayload，此处取 count（先例 appointment.repository.cancel） */
  async confirm(id: string, actorId: string): Promise<number> {
    const r = await this.prisma.orderConfirmation.updateMany({
      where: { id, status: ORDER_STATUS.DRAFT },
      data: {
        status: ORDER_STATUS.CONFIRMED,
        customerConfirmedAt: new Date(),
        customerConfirmedBy: actorId,
      },
    });
    return r.count;
  }
}
