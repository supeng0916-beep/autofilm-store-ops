import { Injectable } from '@nestjs/common';
import type { ApprovalItem, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { ApprovalStatus } from './approval.states';

/** 审批数据访问（S08：controller 不直接调 Prisma）。
 * 状态迁移统一走条件更新（updateMany + 状态前置条件），以返回 count 判定并发冲突（P1-05）。 */
@Injectable()
export class ApprovalRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: {
    type: string;
    payload: Record<string, unknown>;
    requesterId: string;
    basis?: string;
  }): Promise<ApprovalItem> {
    return this.prisma.approvalItem.create({
      data: { ...data, payload: data.payload as Prisma.InputJsonValue },
    });
  }

  findById(id: string): Promise<ApprovalItem | null> {
    return this.prisma.approvalItem.findUnique({ where: { id } });
  }

  /** 列表：按创建时间倒序；status 可选过滤。
   * requesterId（2026-08-28 UI 测试 #8）：非审批人（无 approval:decide）的数据范围收口，
   * 只返回本人发起的审批，payload 业务详情不外泄。 */
  findMany(status?: ApprovalStatus, requesterId?: string): Promise<ApprovalItem[]> {
    return this.prisma.approvalItem.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(requesterId ? { requesterId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /** 条件状态迁移：仅当当前状态为 from 时更新，返回受影响行数。
   * count=0 表示审批项不存在或已离开 from 态（被并发批准/驳回/撤回），由服务层抛 APPROVAL_INVALID_STATE。 */
  async transition(
    id: string,
    from: ApprovalStatus,
    data: {
      status: ApprovalStatus;
      approverId?: string;
      opinion?: string;
      decidedAt?: Date;
    },
  ): Promise<number> {
    const result = await this.prisma.approvalItem.updateMany({ where: { id, status: from }, data });
    return result.count;
  }

  /** 已决定的流失审批项（P3-04 流失决定对账用）：approved/rejected 的 lead.churn */
  findDecidedChurnItems(): Promise<ApprovalItem[]> {
    return this.prisma.approvalItem.findMany({
      where: { type: 'lead.churn', status: { in: ['approved', 'rejected'] } },
      orderBy: { createdAt: 'asc' },
    });
  }
}
