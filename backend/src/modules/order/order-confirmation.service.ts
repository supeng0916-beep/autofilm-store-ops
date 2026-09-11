import { Injectable } from '@nestjs/common';
import type { OrderConfirmation } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { JwtPayload } from '../auth/auth.types';
import { LEAD_FINAL_STATUS } from '../lead/lead.states';
import type { CreateOrderConfirmationDto, ListOrderConfirmationsQueryDto } from './dto/order.dto';
import type { ArrearsRow } from './order-confirmation.repository';
import { OrderConfirmationRepository } from './order-confirmation.repository';
import { ORDER_STATUS } from './order.states';

/** 订单确认单服务（批次1 Task 7，M03 客资成交链）：报价快照 + 定金尾款记录。
 * 可选步骤：不对施工单/预约加任何闸门（老板已拍板 2026-09-01）。 */
@Injectable()
export class OrderConfirmationService {
  constructor(
    private readonly repo: OrderConfirmationRepository,
    private readonly audit: AuditService,
  ) {}

  list(query: ListOrderConfirmationsQueryDto): Promise<OrderConfirmation[]> {
    return this.repo.findMany(query.leadId);
  }

  /** 欠款提醒（批次5 Task 5）：confirmed 且尾款>0 的清单，带客资称呼/电话。
   * 电话按现有可见口径原值返回——仓库仅 chatLink 有角色脱敏先例，电话无脱敏先例；
   * 端点权限 m03:view 已挡无权限角色（清单面向老板/店长财务视野）。 */
  arrears(): Promise<ArrearsRow[]> {
    return this.repo.findArrears();
  }

  /** 创建订单确认单：前置客资必须已成交（finalStatus='won'，confirmWon 口径）；
   * leadId 唯一索引冲突（P2002）转业务 409（先例 referral.service.create 写法） */
  async create(actor: JwtPayload, dto: CreateOrderConfirmationDto): Promise<OrderConfirmation> {
    const lead = await this.repo.findLeadFinalStatus(dto.leadId);
    if (!lead) {
      throw new AppException(ErrorCode.NOT_FOUND, '客资不存在');
    }
    if (lead.finalStatus !== LEAD_FINAL_STATUS.WON) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, '订单确认只能挂在已成交客资上');
    }
    let oc: OrderConfirmation;
    try {
      oc = await this.repo.create({
        leadId: dto.leadId,
        appointmentId: dto.appointmentId,
        products: dto.products,
        quoteSnapshot: dto.quoteSnapshot,
        discountNote: dto.discountNote,
        depositFen: dto.depositFen,
        balanceFen: dto.balanceFen,
        materialCostFen: dto.materialCostFen,
        payMethod: dto.payMethod,
        status: ORDER_STATUS.DRAFT,
        createdBy: actor.sub,
      });
    } catch (err) {
      // leadId 唯一索引冲突：该客资已有订单确认单 → 业务 409（不泄露数据库错误细节）
      if (isUniqueConstraint(err)) {
        throw new AppException(ErrorCode.ORDER_INVALID_STATE, '该客资已有订单确认单');
      }
      throw err;
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'order_confirmation.created',
      objectType: 'order_confirmation',
      objectId: oc.id,
      after: {
        leadId: oc.leadId,
        products: oc.products,
        quoteSnapshot: oc.quoteSnapshot,
        depositFen: oc.depositFen,
        balanceFen: oc.balanceFen,
        ...(oc.materialCostFen !== null ? { materialCostFen: oc.materialCostFen } : {}),
        ...(oc.payMethod !== null ? { payMethod: oc.payMethod } : {}),
        ...(oc.appointmentId !== null ? { appointmentId: oc.appointmentId } : {}),
      },
    });
    return oc;
  }

  /** 客户确认：条件更新仅 draft 生效，写确认时间/确认人；
   * count=0 即已确认（含并发抢先）→ 409（先例 referral.service.markWon 口径） */
  async confirm(actor: JwtPayload, id: string): Promise<OrderConfirmation> {
    const before = await this.repo.findById(id);
    if (!before) {
      throw new AppException(ErrorCode.NOT_FOUND, '订单确认单不存在');
    }
    const count = await this.repo.confirm(id, actor.sub);
    if (count === 0) {
      throw new AppException(ErrorCode.ORDER_INVALID_STATE, '订单确认单已确认，不可重复操作');
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'order_confirmation.confirmed',
      objectType: 'order_confirmation',
      objectId: id,
      before: { status: before.status },
      after: { status: ORDER_STATUS.CONFIRMED, customerConfirmedBy: actor.sub },
    });
    const updated = await this.repo.findById(id);
    // 条件更新 count=1 后必然存在，此处兜底类型
    return updated!;
  }
}

/** Prisma 唯一约束冲突识别（P2002），不依赖 @prisma/client 具体错误类（先例 referral.service 同款） */
function isUniqueConstraint(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}
