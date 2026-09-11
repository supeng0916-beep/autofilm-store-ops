import { Injectable } from '@nestjs/common';
import type { Appointment, AppointmentTechnicianChange, Prisma, Technician } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { APPOINTMENT_STATUS, TECH_CHANGE_STATUS } from './appointment.states';
import { normalizeWorkbench } from './delivery.constants';

/** 档期时段（冲突检测输入）：endAt 必填（时段计算前提） */
export interface TimeSlot {
  workbench?: string | null;
  technicianName?: string | null;
  startAt: Date;
  endAt: Date;
  excludeId?: string;
}

/** 预约数据访问（S08：controller 不直接调 Prisma） */
@Injectable()
export class AppointmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.AppointmentUncheckedCreateInput): Promise<Appointment> {
    return this.prisma.appointment.create({ data });
  }

  findById(id: string): Promise<Appointment | null> {
    return this.prisma.appointment.findUnique({ where: { id } });
  }

  findMany(filter: { from?: Date; to?: Date; status?: string }): Promise<Appointment[]> {
    const where: Prisma.AppointmentWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.from || filter.to
        ? {
            startAt: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lte: filter.to } : {}),
            },
          }
        : {}),
    };
    return this.prisma.appointment.findMany({ where, orderBy: { startAt: 'asc' } });
  }

  /** 档期冲突检测（P5-01）：同一工位或同一技师，时段重叠（半开区间 [start,end)）且未取消。
   * endAt 为空的存量预约不参与检测（创建接口强制 endAt，见 DTO）。
   * 2026-08-28 UI 测试 #5：工位比对改内存归一化等值——存量「工位A」与新写法「A」
   * 视为同一物理工位（此前 SQL 精确等值会被写法漂移绕过，同位双排期放行）。 */
  async findConflicts(slot: TimeSlot): Promise<Appointment[]> {
    const overlap: Prisma.AppointmentWhereInput = {
      status: { not: APPOINTMENT_STATUS.CANCELLED },
      endAt: { gt: slot.startAt },
      startAt: { lt: slot.endAt },
      ...(slot.excludeId ? { id: { not: slot.excludeId } } : {}),
    };
    const candidates = await this.prisma.appointment.findMany({ where: overlap });
    const bench = slot.workbench ? normalizeWorkbench(slot.workbench) : null;
    return candidates.filter(
      (a) =>
        (bench !== null && a.workbench !== null && normalizeWorkbench(a.workbench) === bench) ||
        (slot.technicianName !== undefined &&
          slot.technicianName !== null &&
          a.technicianName === slot.technicianName),
    );
  }

  /** 条件取消：仅 pending/confirmed 可取消（并发/重复操作返回 0）。
   * updateMany 返回 BatchPayload，此处取 count */
  async cancel(id: string): Promise<number> {
    const r = await this.prisma.appointment.updateMany({
      where: { id, status: { in: [APPOINTMENT_STATUS.PENDING, APPOINTMENT_STATUS.CONFIRMED] } },
      data: { status: APPOINTMENT_STATUS.CANCELLED },
    });
    return r.count;
  }

  /** 店长确认（P5-03，审批回调触发）：条件更新防重复确认 */
  async confirmByManager(id: string, approverId: string): Promise<number> {
    const r = await this.prisma.appointment.updateMany({
      where: { id, managerConfirmed: false },
      data: {
        managerConfirmed: true,
        managerConfirmedBy: approverId,
        managerConfirmedAt: new Date(),
        status: APPOINTMENT_STATUS.CONFIRMED,
      },
    });
    return r.count;
  }

  /** 更新技师（仅替换确认后调用，P5-02） */
  setTechnician(id: string, name: string): Promise<Appointment> {
    return this.prisma.appointment.update({ where: { id }, data: { technicianName: name } });
  }

  leadExists(id: string): Promise<boolean> {
    return this.prisma.lead.findUnique({ where: { id }, select: { id: true } }).then((l) => !!l);
  }

  /** 按姓名查技师（技能池校验用，v1.5 §5.4）：同名取最早入库者 */
  findTechnicianByName(name: string): Promise<Technician | null> {
    return this.prisma.technician.findFirst({ where: { name }, orderBy: { createdAt: 'asc' } });
  }

  // —— 技师替换记录（P5-02） ——

  createTechnicianChange(
    data: Prisma.AppointmentTechnicianChangeUncheckedCreateInput,
  ): Promise<AppointmentTechnicianChange> {
    return this.prisma.appointmentTechnicianChange.create({ data });
  }

  findTechnicianChange(id: string): Promise<AppointmentTechnicianChange | null> {
    return this.prisma.appointmentTechnicianChange.findUnique({ where: { id } });
  }

  listTechnicianChanges(appointmentId: string): Promise<AppointmentTechnicianChange[]> {
    return this.prisma.appointmentTechnicianChange.findMany({
      where: { appointmentId },
      orderBy: { requestedAt: 'desc' },
    });
  }

  /** 条件确认：仅 pending 可确认（客户确认后替换才生效）；原因字段保留不覆盖，备注走审计 */
  async confirmTechnicianChange(id: string, confirmMethod: string): Promise<number> {
    const r = await this.prisma.appointmentTechnicianChange.updateMany({
      where: { id, status: TECH_CHANGE_STATUS.PENDING },
      data: {
        status: TECH_CHANGE_STATUS.CONFIRMED,
        confirmMethod,
        confirmedAt: new Date(),
      },
    });
    return r.count;
  }

  // —— 知识库确定性提示（P5-01 工时参考 / P5-02 技师专长） ——

  /** 生效知识条目关键词匹配（title/content ILIKE），最多 take 条 */
  findActiveKnowledgeByKeyword(
    kind: string,
    keyword: string,
    take = 3,
  ): Promise<Array<{ title: string; source: string | null; key: string }>> {
    return this.prisma.knowledgeItem.findMany({
      where: {
        status: 'active',
        kind,
        OR: [
          { title: { contains: keyword, mode: 'insensitive' } },
          { content: { contains: keyword, mode: 'insensitive' } },
        ],
      },
      select: { title: true, source: true, key: true },
      take,
    });
  }
}
