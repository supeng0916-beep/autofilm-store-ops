import { Injectable } from '@nestjs/common';
import type {
  AftercareVisit,
  CustomerReview,
  Prisma,
  ReferralRecord,
  ServiceRequest,
  WarrantyRegistration,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { REFERRAL_STATUS, VISIT_STATUS, WARRANTY_STATUS } from './aftercare.states';

/** 售后域数据访问（M09 批次1；S08：controller 不直接调 Prisma）：回访 + 售后受理 + 质保登记 + 转介绍 + 客户评价 */
@Injectable()
export class AftercareRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 列表（dueAt asc = 先到期先处理）；可选按状态过滤 */
  list(status?: string): Promise<AftercareVisit[]> {
    return this.prisma.aftercareVisit.findMany({
      where: status ? { status } : {},
      orderBy: { dueAt: 'asc' },
    });
  }

  create(data: Prisma.AftercareVisitUncheckedCreateInput): Promise<AftercareVisit> {
    return this.prisma.aftercareVisit.create({ data });
  }

  /** 批量创建回访（单事务）：交付钩子 d7/d30 成对落库——
   * 第二条中途失败不能留下半套计划（幂等闸 countByWorkOrder>0 会使后续调用永远跳过，
   * 30 天回访将永久缺失）。先例 system.repository.createUserWithRoles 的 $transaction 写法 */
  async createBatch(items: Prisma.AftercareVisitUncheckedCreateInput[]): Promise<AftercareVisit[]> {
    return this.prisma.$transaction(async (tx) => {
      const rows: AftercareVisit[] = [];
      for (const data of items) rows.push(await tx.aftercareVisit.create({ data }));
      return rows;
    });
  }

  findById(id: string): Promise<AftercareVisit | null> {
    return this.prisma.aftercareVisit.findUnique({ where: { id } });
  }

  /** 施工单已有回访条数（planForWorkOrder 交付钩子幂等判断：含手工 custom 在内） */
  countByWorkOrder(workOrderId: string): Promise<number> {
    return this.prisma.aftercareVisit.count({ where: { workOrderId } });
  }

  /** 条件标记完成：仅 pending 可执行（并发/重复操作返回 0）。
   * updateMany 返回 BatchPayload，此处取 count（先例 appointment.repository.cancel） */
  async markDone(id: string, actorId: string, note?: string): Promise<number> {
    const r = await this.prisma.aftercareVisit.updateMany({
      where: { id, status: VISIT_STATUS.PENDING },
      data: {
        status: VISIT_STATUS.DONE,
        executedBy: actorId,
        executedAt: new Date(),
        ...(note !== undefined ? { note } : {}),
      },
    });
    return r.count;
  }

  /** 条件标记跳过：同 markDone 口径（仅 pending 可跳过） */
  async markSkipped(id: string, actorId: string, note?: string): Promise<number> {
    const r = await this.prisma.aftercareVisit.updateMany({
      where: { id, status: VISIT_STATUS.PENDING },
      data: {
        status: VISIT_STATUS.SKIPPED,
        executedBy: actorId,
        executedAt: new Date(),
        ...(note !== undefined ? { note } : {}),
      },
    });
    return r.count;
  }

  // ── 售后受理（ServiceRequest）─────────────────────────────────────────────

  /** 受理列表：可选状态/种类双维过滤；createdAt desc = 新受理在前 */
  srList(status?: string, kind?: string): Promise<ServiceRequest[]> {
    return this.prisma.serviceRequest.findMany({
      where: {
        ...(status !== undefined ? { status } : {}),
        ...(kind !== undefined ? { kind } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  srCreate(data: Prisma.ServiceRequestUncheckedCreateInput): Promise<ServiceRequest> {
    return this.prisma.serviceRequest.create({ data });
  }

  srFindById(id: string): Promise<ServiceRequest | null> {
    return this.prisma.serviceRequest.findUnique({ where: { id } });
  }

  /** 条件更新受理：仅当前状态在 allowedFrom 内才生效（单向状态机 + 终态防重），
   * 并发/越态操作返回 0（先例 markDone/appointment.repository.cancel） */
  async srUpdate(
    id: string,
    data: Prisma.ServiceRequestUncheckedUpdateInput,
    allowedFrom: string[],
  ): Promise<number> {
    const r = await this.prisma.serviceRequest.updateMany({
      where: { id, status: { in: allowedFrom } },
      data,
    });
    return r.count;
  }

  // ── 质保登记（WarrantyRegistration）──────────────────────────────────────

  /** 质保列表：可选状态过滤；createdAt desc = 新登记在前 */
  wrList(status?: string): Promise<WarrantyRegistration[]> {
    return this.prisma.warrantyRegistration.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
    });
  }

  wrCreate(data: Prisma.WarrantyRegistrationUncheckedCreateInput): Promise<WarrantyRegistration> {
    return this.prisma.warrantyRegistration.create({ data });
  }

  wrFindById(id: string): Promise<WarrantyRegistration | null> {
    return this.prisma.warrantyRegistration.findUnique({ where: { id } });
  }

  /** 条件登记：仅 pending 可置 registered（终态防重，并发/重复操作返回 0），
   * 登记动作统一写登记时间（先例 markDone/srUpdate 口径） */
  async wrRegister(id: string, note?: string): Promise<number> {
    const r = await this.prisma.warrantyRegistration.updateMany({
      where: { id, status: WARRANTY_STATUS.PENDING },
      data: {
        status: WARRANTY_STATUS.REGISTERED,
        registeredAt: new Date(),
        ...(note !== undefined ? { note } : {}),
      },
    });
    return r.count;
  }

  // ── 转介绍（ReferralRecord）──────────────────────────────────────────────

  /** 转介绍列表：可选状态过滤；createdAt desc = 新登记在前 */
  rfList(status?: string): Promise<ReferralRecord[]> {
    return this.prisma.referralRecord.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 创建转介绍：referredLeadId 唯一索引（P2002）由服务层捕获转业务 409 */
  rfCreate(data: Prisma.ReferralRecordUncheckedCreateInput): Promise<ReferralRecord> {
    return this.prisma.referralRecord.create({ data });
  }

  rfFindById(id: string): Promise<ReferralRecord | null> {
    return this.prisma.referralRecord.findUnique({ where: { id } });
  }

  /** 条件标成交：仅 pending 可置 won（终态防重，并发/重复操作返回 0） */
  async rfMarkWon(id: string, note?: string): Promise<number> {
    const r = await this.prisma.referralRecord.updateMany({
      where: { id, status: REFERRAL_STATUS.PENDING },
      data: {
        status: REFERRAL_STATUS.WON,
        ...(note !== undefined ? { note } : {}),
      },
    });
    return r.count;
  }

  // ── 客户评价（CustomerReview，缺口补齐批次 Task 2，append-only）──────────

  /** 评价列表：reviewedAt desc = 新评价在前（无过滤参数，append-only 只读登记流水） */
  rvList(): Promise<CustomerReview[]> {
    return this.prisma.customerReview.findMany({
      orderBy: { reviewedAt: 'desc' },
    });
  }

  rvCreate(data: Prisma.CustomerReviewUncheckedCreateInput): Promise<CustomerReview> {
    return this.prisma.customerReview.create({ data });
  }
}
