import { Injectable } from '@nestjs/common';
import type { ReferralRecord } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { JwtPayload } from '../auth/auth.types';
import { AftercareRepository } from './aftercare.repository';
import { REFERRAL_STATUS } from './aftercare.states';
import type { CreateReferralDto, ListReferralsQueryDto } from './dto/referral.dto';

/** 转介绍服务（M09 批次1）：老客带新登记（介绍人客户 → 被转介绍客资/客户），
 * 新客资成交后人工标 won。同一客资仅一条登记（referredLeadId 唯一索引），
 * 重复创建捕获数据库唯一约束（P2002）转业务 409。 */
@Injectable()
export class ReferralService {
  constructor(
    private readonly repo: AftercareRepository,
    private readonly audit: AuditService,
  ) {}

  list(query: ListReferralsQueryDto): Promise<ReferralRecord[]> {
    return this.repo.rfList(query.status);
  }

  /** 创建转介绍：落库即 pending；同一 referredLeadId 撞唯一索引（P2002）→ 409 AFTERCARE_INVALID_STATE */
  async create(actor: JwtPayload, dto: CreateReferralDto): Promise<ReferralRecord> {
    let rf: ReferralRecord;
    try {
      rf = await this.repo.rfCreate({
        referrerCustomerId: dto.referrerCustomerId,
        referredLeadId: dto.referredLeadId,
        referredCustomerId: dto.referredCustomerId,
        note: dto.note,
        status: REFERRAL_STATUS.PENDING,
        createdBy: actor.sub,
      });
    } catch (err) {
      // referredLeadId 唯一索引冲突：该客资已有转介绍登记 → 业务 409（不泄露数据库错误细节）
      if (isUniqueConstraint(err)) {
        throw new AppException(ErrorCode.AFTERCARE_INVALID_STATE, '该客资已有转介绍登记');
      }
      throw err;
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'referral.created',
      objectType: 'referral_record',
      objectId: rf.id,
      after: {
        referrerCustomerId: dto.referrerCustomerId,
        ...(dto.referredLeadId !== undefined ? { referredLeadId: dto.referredLeadId } : {}),
        ...(dto.referredCustomerId !== undefined
          ? { referredCustomerId: dto.referredCustomerId }
          : {}),
      },
    });
    return rf;
  }

  /** 标成交：条件更新仅 pending 生效；
   * count=0 即已成交（含并发抢先）或不存在 → 409（先例 service-request.update 口径） */
  async markWon(actor: JwtPayload, id: string, note?: string): Promise<ReferralRecord> {
    const before = await this.repo.rfFindById(id);
    const count = await this.repo.rfMarkWon(id, note);
    if (count === 0) {
      throw new AppException(
        ErrorCode.AFTERCARE_INVALID_STATE,
        '状态不允许该操作（已成交或不存在）',
      );
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'referral.marked_won',
      objectType: 'referral_record',
      objectId: id,
      before: { status: before?.status },
      after: { status: REFERRAL_STATUS.WON, ...(note !== undefined ? { note } : {}) },
    });
    const updated = await this.repo.rfFindById(id);
    // 条件更新 count=1 后必然存在，此处兜底类型
    return updated!;
  }
}

/** Prisma 唯一约束冲突识别（P2002），不依赖 @prisma/client 具体错误类（先例 lead.repository 同款） */
function isUniqueConstraint(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}
