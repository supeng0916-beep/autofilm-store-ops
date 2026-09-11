import { Injectable } from '@nestjs/common';
import type { WarrantyRegistration } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { JwtPayload } from '../auth/auth.types';
import { AftercareRepository } from './aftercare.repository';
import { WARRANTY_STATUS } from './aftercare.states';
import type { CreateWarrantyDto, ListWarrantyQueryDto } from './dto/warranty.dto';

/** 质保登记服务（M09 批次1）：质保登记单的创建与登记动作。
 * 红线（任务书 §5.7）：本表仅登记质保事实（产品/编号/登记时间），
 * 严禁实现成理赔承诺或理赔审批——不得出现赔付额度、有效期承诺、理赔裁决等语义。
 * 登记走条件更新（wrRegister 返回 count），并发/重复一律 409。 */
@Injectable()
export class WarrantyService {
  constructor(
    private readonly repo: AftercareRepository,
    private readonly audit: AuditService,
  ) {}

  list(query: ListWarrantyQueryDto): Promise<WarrantyRegistration[]> {
    return this.repo.wrList(query.status);
  }

  /** 创建质保登记：落库即 pending（登记单待登记态）；载体与产品信息均可选，允许先占位后补全 */
  async create(actor: JwtPayload, dto: CreateWarrantyDto): Promise<WarrantyRegistration> {
    const wr = await this.repo.wrCreate({
      workOrderId: dto.workOrderId,
      customerId: dto.customerId,
      productModel: dto.productModel,
      registrationNo: dto.registrationNo,
      registeredAt: dto.registeredAt,
      note: dto.note,
      status: WARRANTY_STATUS.PENDING,
      createdBy: actor.sub,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'warranty.created',
      objectType: 'warranty_registration',
      objectId: wr.id,
      after: {
        status: WARRANTY_STATUS.PENDING,
        ...(dto.workOrderId !== undefined ? { workOrderId: dto.workOrderId } : {}),
        ...(dto.customerId !== undefined ? { customerId: dto.customerId } : {}),
        ...(dto.productModel !== undefined ? { productModel: dto.productModel } : {}),
        ...(dto.registrationNo !== undefined ? { registrationNo: dto.registrationNo } : {}),
        ...(dto.registeredAt !== undefined ? { registeredAt: dto.registeredAt.toISOString() } : {}),
      },
    });
    return wr;
  }

  /** 登记动作：条件更新仅 pending 生效，统一写 registeredAt；
   * count=0 即已登记（含并发抢先）或不存在 → 409（先例 service-request.update 口径） */
  async register(actor: JwtPayload, id: string, note?: string): Promise<WarrantyRegistration> {
    const before = await this.repo.wrFindById(id);
    const count = await this.repo.wrRegister(id, note);
    if (count === 0) {
      throw new AppException(
        ErrorCode.AFTERCARE_INVALID_STATE,
        '状态不允许该操作（已登记或不存在）',
      );
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'warranty.registered',
      objectType: 'warranty_registration',
      objectId: id,
      before: { status: before?.status },
      after: { status: WARRANTY_STATUS.REGISTERED, ...(note !== undefined ? { note } : {}) },
    });
    const updated = await this.repo.wrFindById(id);
    // 条件更新 count=1 后必然存在，此处兜底类型
    return updated!;
  }
}
