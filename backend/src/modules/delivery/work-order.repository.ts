import { Injectable } from '@nestjs/common';
import type { Prisma, Technician, WorkOrder } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { WorkOrderStage } from './work-order.states';

/** 施工单数据访问（S08） */
@Injectable()
export class WorkOrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 生成单号 W-YYYYMMDD-NNNN（按日递增；并发极低场景，唯一索引兜底重试由调用方处理） */
  async nextOrderNo(): Promise<string> {
    const now = new Date();
    const ymd = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('');
    const prefix = `W-${ymd}-`;
    const count = await this.prisma.workOrder.count({ where: { orderNo: { startsWith: prefix } } });
    return `${prefix}${String(count + 1).padStart(4, '0')}`;
  }

  create(data: Prisma.WorkOrderUncheckedCreateInput): Promise<WorkOrder> {
    return this.prisma.workOrder.create({ data });
  }

  findById(id: string): Promise<WorkOrder | null> {
    return this.prisma.workOrder.findUnique({ where: { id } });
  }

  findMany(stage?: string): Promise<WorkOrder[]> {
    return this.prisma.workOrder.findMany({
      where: stage ? { stage } : {},
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 条件阶段迁移（防并发/跳步/重复操作）：from 为允许的当前阶段集合，count=0 即无效 */
  async transitionStage(
    id: string,
    from: WorkOrderStage[],
    data: Prisma.WorkOrderUpdateInput,
  ): Promise<number> {
    const r = await this.prisma.workOrder.updateMany({ where: { id, stage: { in: from } }, data });
    return r.count;
  }

  update(id: string, data: Prisma.WorkOrderUpdateInput): Promise<WorkOrder> {
    return this.prisma.workOrder.update({ where: { id }, data });
  }

  findAppointment(id: string) {
    return this.prisma.appointment.findUnique({ where: { id } });
  }

  /** 按姓名查技师（建单技能池校验用，v1.5 §5.4）：同名取最早入库者（appointment.repository 同口径） */
  findTechnicianByName(name: string): Promise<Technician | null> {
    return this.prisma.technician.findFirst({ where: { name }, orderBy: { createdAt: 'asc' } });
  }

  /** 用户角色码（数据范围过滤：销售仅见本人客资关联施工单） */
  async userRoleCodes(userId: string): Promise<string[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { userRoles: { select: { role: { select: { code: true } } } } },
    });
    return user?.userRoles.map((ur) => ur.role.code) ?? [];
  }

  /** 用户负责的客资 ID 集（sales 视野过滤） */
  async ownedLeadIds(userId: string): Promise<string[]> {
    const leads = await this.prisma.lead.findMany({
      where: { ownerUserId: userId },
      select: { id: true },
    });
    return leads.map((l) => l.id);
  }

  /** 按预约查已有施工单（2026-08-28 bug4：同一预约禁止重复建单） */
  findFirstByAppointmentId(appointmentId: string): Promise<WorkOrder | null> {
    return this.prisma.workOrder.findFirst({ where: { appointmentId } });
  }

  /** 养护说明草稿素材（确定性拼接，P5-05；2026-08-28 bug2 修复：
   * 优先取标题/正文含「养护」的生效条目（养护类优先、与交付场景对口）；
   * 无养护条目才退回质保/品牌兜底——旧实现固定取质保/品牌前 5 条，
   * 知识库无养护条目时草稿与交付养护说明完全无关（门店报障）。 */
  async findCareKnowledge(): Promise<
    Array<{ title: string; content: string; source: string | null }>
  > {
    const care = await this.prisma.knowledgeItem.findMany({
      where: {
        status: 'active',
        OR: [{ title: { contains: '养护' } }, { content: { contains: '养护' } }],
      },
      select: { title: true, content: true, source: true },
      take: 5,
    });
    if (care.length > 0) return care;
    return this.prisma.knowledgeItem.findMany({
      where: { status: 'active', kind: { in: ['warranty', 'brand'] } },
      select: { title: true, content: true, source: true },
      orderBy: { kind: 'asc' },
      take: 5,
    });
  }
}

/** 交付节点留痕结构（P5-05：各有确认人与时间；occurredAt 为补录原时间） */
export interface ConfirmNode {
  by: string;
  byName: string;
  at: string;
  occurredAt?: string;
  note?: string;
}
