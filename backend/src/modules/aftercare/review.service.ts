import { Injectable } from '@nestjs/common';
import type { CustomerReview } from '@prisma/client';

import { AuditService } from '../../common/audit';
import type { JwtPayload } from '../auth/auth.types';
import { AftercareRepository } from './aftercare.repository';
import type { CreateReviewDto } from './dto/review.dto';

/** 客户评价服务（M09 缺口补齐批次 Task 2）：交付后客户评分与评语登记。
 * append-only——仅提供列表与创建，不提供更新/删除（先例审计命名：
 * action review.created，objectType customer_review）。 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly repo: AftercareRepository,
    private readonly audit: AuditService,
  ) {}

  list(): Promise<CustomerReview[]> {
    return this.repo.rvList();
  }

  /** 创建评价：落库即留痕（S11 可追溯）；三个载体 ID 均为可选 */
  async create(actor: JwtPayload, dto: CreateReviewDto): Promise<CustomerReview> {
    const rv = await this.repo.rvCreate({
      customerId: dto.customerId,
      leadId: dto.leadId,
      workOrderId: dto.workOrderId,
      score: dto.score,
      content: dto.content,
      createdBy: actor.sub,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'review.created',
      objectType: 'customer_review',
      objectId: rv.id,
      after: {
        score: dto.score,
        ...(dto.customerId !== undefined ? { customerId: dto.customerId } : {}),
        ...(dto.leadId !== undefined ? { leadId: dto.leadId } : {}),
        ...(dto.workOrderId !== undefined ? { workOrderId: dto.workOrderId } : {}),
        ...(dto.content !== undefined ? { content: dto.content } : {}),
      },
    });
    return rv;
  }
}
