import { Injectable, Logger } from '@nestjs/common';
import type { ServiceRequest } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { JwtPayload } from '../auth/auth.types';
import { NotificationService } from '../notification/notification.service';
import { AftercareRepository } from './aftercare.repository';
import { SR_KIND, SR_STATUS } from './aftercare.states';
import type {
  CreateServiceRequestDto,
  ListServiceRequestsQueryDto,
  UpdateServiceRequestDto,
} from './dto/service-request.dto';

/** 售后受理服务（M09 批次1）：咨询/复检/投诉/其他四类受理的创建与单向推进。
 * 投诉创建即通知老板（notifyRoleHolders(['boss'])，safeNotify 包装不外抛）。
 * 状态机单向：open → in_progress → resolved，resolved 为终态；
 * 推进走条件更新（srUpdate 返回 count），并发/越态一律 409。 */
@Injectable()
export class ServiceRequestService {
  private readonly logger = new Logger(ServiceRequestService.name);

  constructor(
    private readonly repo: AftercareRepository,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  list(query: ListServiceRequestsQueryDto): Promise<ServiceRequest[]> {
    return this.repo.srList(query.status, query.kind);
  }

  /** 创建受理：落库即 open；投诉类直通老板（先例 asset.service notifyRoleHolders）。
   * 通知尽力而为——失败仅记日志，不阻塞受理登记 */
  async create(actor: JwtPayload, dto: CreateServiceRequestDto): Promise<ServiceRequest> {
    const sr = await this.repo.srCreate({
      kind: dto.kind,
      content: dto.content,
      customerId: dto.customerId,
      leadId: dto.leadId,
      workOrderId: dto.workOrderId,
      status: SR_STATUS.OPEN,
      createdBy: actor.sub,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'service_request.created',
      objectType: 'service_request',
      objectId: sr.id,
      after: { kind: dto.kind, content: dto.content },
    });
    if (dto.kind === SR_KIND.COMPLAINT) {
      // 投诉直通老板：正文截前 60 字（通知中心列表口径，避免长文刷屏）
      await this.safeNotify(
        () =>
          this.notifications.notifyRoleHolders(['boss'], {
            kind: 'service_request.complaint',
            title: '新投诉受理',
            body: dto.content.slice(0, 60),
            link: '/aftercare',
            sourceType: 'service_request',
            sourceId: sr.id,
          }),
        `service_request.complaint(${sr.id})`,
      );
    }
    return sr;
  }

  /** 推进受理（领单/解决/改处理人等）：单向状态机——
   * - in_progress 仅可从 open（领单）；
   * - resolved 可从 open/in_progress（允许不经领单直接解决），自动写 resolvedAt；
   * - 条件更新 count=0 → 已解决或不存在 → 409 AFTERCARE_INVALID_STATE。 */
  async update(
    actor: JwtPayload,
    id: string,
    dto: UpdateServiceRequestDto,
  ): Promise<ServiceRequest> {
    const before = await this.repo.srFindById(id);
    const data: Record<string, unknown> = {};
    const auditAfter: Record<string, unknown> = {};
    let allowedFrom: string[];
    if (dto.status === SR_STATUS.IN_PROGRESS) {
      allowedFrom = [SR_STATUS.OPEN];
      data.status = auditAfter.status = SR_STATUS.IN_PROGRESS;
      if (dto.handlerUserId !== undefined)
        data.handlerUserId = auditAfter.handlerUserId = dto.handlerUserId;
      if (dto.result !== undefined) data.result = auditAfter.result = dto.result;
    } else if (dto.status === SR_STATUS.RESOLVED) {
      allowedFrom = [SR_STATUS.OPEN, SR_STATUS.IN_PROGRESS];
      data.status = auditAfter.status = SR_STATUS.RESOLVED;
      data.resolvedAt = new Date();
      auditAfter.resolvedAt = (data.resolvedAt as Date).toISOString();
      if (dto.result !== undefined) data.result = auditAfter.result = dto.result;
      if (dto.handlerUserId !== undefined)
        data.handlerUserId = auditAfter.handlerUserId = dto.handlerUserId;
    } else {
      // 无状态迁移的字段更新（如领单后改派处理人）：仅未解决态可改
      allowedFrom = [SR_STATUS.OPEN, SR_STATUS.IN_PROGRESS];
      if (dto.handlerUserId !== undefined)
        data.handlerUserId = auditAfter.handlerUserId = dto.handlerUserId;
      if (dto.result !== undefined) data.result = auditAfter.result = dto.result;
    }
    const count = await this.repo.srUpdate(id, data, allowedFrom);
    if (count === 0) {
      throw new AppException(
        ErrorCode.AFTERCARE_INVALID_STATE,
        '状态不允许该操作（已解决或不存在）',
      );
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'service_request.updated',
      objectType: 'service_request',
      objectId: id,
      before: { status: before?.status },
      after: auditAfter,
    });
    const updated = await this.repo.srFindById(id);
    // 条件更新 count=1 后必然存在，此处兜底类型
    return updated!;
  }

  /** 尽力而为发通知（S09，先例 appointment.service）：内部兜底捕获，任何失败仅记日志不外抛 */
  private async safeNotify(action: () => Promise<unknown>, context: string): Promise<void> {
    try {
      await action();
    } catch (err) {
      this.logger.warn(
        `通知发送失败（${context}）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
