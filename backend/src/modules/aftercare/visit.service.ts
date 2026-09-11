import { Injectable } from '@nestjs/common';
import type { AftercareVisit } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { JwtPayload } from '../auth/auth.types';
import { NotificationService } from '../notification/notification.service';
import { AftercareRepository } from './aftercare.repository';
import { VISIT_PLAN, VISIT_STATUS } from './aftercare.states';
import type { CreateVisitDto, ListVisitsQueryDto } from './dto/aftercare.dto';

const DAY_MS = 24 * 3600 * 1000;

/** 回访服务（M09 批次1）：列表过滤 / 手工 custom 创建 / 执行与跳过 / 交付钩子 d7-d30 生成。
 * 全部规则为确定性代码（S11）；执行/跳过走条件更新防重复（markDone/markSkipped 返回 count）。
 * NotificationService 按 brief 注入，预留本批次后续任务的通知接线（先例 appointment.service）。 */
@Injectable()
export class VisitService {
  constructor(
    private readonly repo: AftercareRepository,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  list(query: ListVisitsQueryDto): Promise<AftercareVisit[]> {
    return this.repo.list(query.status);
  }

  /** 手工创建（boss/店长/销售，m09:edit）：plan 固定 custom，到期日必填。
   * customerId 不解析——手工补录的客户维度以施工单载体为准，留空（自动计划行由钩子入参带入） */
  async create(actor: JwtPayload, dto: CreateVisitDto): Promise<AftercareVisit> {
    const visit = await this.repo.create({
      workOrderId: dto.workOrderId,
      plan: VISIT_PLAN.CUSTOM,
      dueAt: dto.dueAt,
      note: dto.note,
      createdBy: actor.sub,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'visit.created',
      objectType: 'aftercare_visit',
      objectId: visit.id,
      after: {
        workOrderId: dto.workOrderId,
        plan: VISIT_PLAN.CUSTOM,
        dueAt: dto.dueAt.toISOString(),
      },
    });
    return visit;
  }

  /** 执行回访：条件更新仅 pending 生效；count=0 即已完成/跳过（含并发抢先）→ 409 */
  async execute(actor: JwtPayload, id: string, note?: string): Promise<AftercareVisit> {
    const before = await this.get(id);
    const count = await this.repo.markDone(id, actor.sub, note);
    if (count === 0) {
      throw new AppException(ErrorCode.AFTERCARE_INVALID_STATE, '回访已完成或跳过，不能重复操作');
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'visit.executed',
      objectType: 'aftercare_visit',
      objectId: id,
      before: { status: before.status },
      after: { status: VISIT_STATUS.DONE, ...(note !== undefined ? { note } : {}) },
    });
    return this.get(id);
  }

  /** 跳过回访：与执行同口径（条件更新 + 审计 + 409 防重） */
  async skip(actor: JwtPayload, id: string, note?: string): Promise<AftercareVisit> {
    const before = await this.get(id);
    const count = await this.repo.markSkipped(id, actor.sub, note);
    if (count === 0) {
      throw new AppException(ErrorCode.AFTERCARE_INVALID_STATE, '回访已完成或跳过，不能重复操作');
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'visit.skipped',
      objectType: 'aftercare_visit',
      objectId: id,
      before: { status: before.status },
      after: { status: VISIT_STATUS.SKIPPED, ...(note !== undefined ? { note } : {}) },
    });
    return this.get(id);
  }

  /** 交付钩子（Task 5 交付确认调用）：为施工单生成 d7/d30 回访，幂等——
   * 该单已有回访记录（含手工 custom）返回 0；否则单事务创建 d7（+7天）与 d30（+30天）两条并返回 2
   * （createBatch 事务包裹：半套失败整体回滚，避免幂等闸把 30 天回访永久漏掉） */
  async planForWorkOrder(
    workOrderId: string,
    customerId: string | null,
    deliveredAt: Date,
  ): Promise<number> {
    if ((await this.repo.countByWorkOrder(workOrderId)) > 0) return 0;
    const rows = await this.repo.createBatch([
      {
        workOrderId,
        customerId,
        plan: VISIT_PLAN.D7,
        dueAt: new Date(deliveredAt.getTime() + 7 * DAY_MS),
      },
      {
        workOrderId,
        customerId,
        plan: VISIT_PLAN.D30,
        dueAt: new Date(deliveredAt.getTime() + 30 * DAY_MS),
      },
    ]);
    return rows.length;
  }

  private async get(id: string): Promise<AftercareVisit> {
    const visit = await this.repo.findById(id);
    if (!visit) throw new AppException(ErrorCode.NOT_FOUND, '回访不存在');
    return visit;
  }
}
