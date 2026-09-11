import { Injectable } from '@nestjs/common';
import type { Lead, Prisma } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../auth/auth.types';
import { LEAD_EVENT_KIND } from './lead.constants';
import { normalizePhone, normalizeWechat } from './lead.normalize';
import { LeadRepository } from './lead.repository';

// 归一化纯函数从 dedup.service 一并导出，供测试/消费方引用
export { normalizePhone, normalizeWechat } from './lead.normalize';

/** 客资去重与合并（P3-02）：联系方式归一化命中 → 重复派发保留挂链（D-P3-12）→ 人工向下合并。
 * 规则可配置留 SystemMeta `dedup.config` 占位（V1 硬编码归一化键：电话或微信任一命中）。
 * 并发口径：V1 单机单进程，去重临界区靠进程内 KeyedLock 串行化（见 import-lock.ts）；
 * 多实例部署需在后续 schema 任务加「归一化联系方式列 + 唯一索引」兜底，进程内互斥不跨实例。 */
@Injectable()
export class DedupService {
  constructor(
    private readonly repo: LeadRepository,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  /** 找重复主 Lead：归一化电话或微信任一命中（dupOfLeadId 为空的最早一条为主）。
   * 两级匹配（T5）：active 主客资优先；无命中再兜底 won/lost——主客资已成交/战败后
   * 同联系方式回访、复购派发仍挂链，新客资沿用既有 customerId（复购统计不漏算）。
   * excludeId 排除刚创建待判重的 Lead 自身；tx 供导入事务内读（需看到同批未提交 Lead）。 */
  async findDuplicates(
    candidate: { phone?: string | null; wechat?: string | null },
    excludeId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Lead | null> {
    const phone = candidate.phone ? normalizePhone(candidate.phone) : null;
    const wechat = candidate.wechat ? normalizeWechat(candidate.wechat) : null;
    if (!phone && !wechat) return null;
    return this.repo.findPrimaryByContact(phone, wechat, excludeId, tx);
  }

  /** 重复派发挂链：只设 dupOfLeadId 并写 dup_linked 事件，不删除任何 Lead/事件（D-P3-12）。 */
  async linkDuplicate(
    lead: Lead,
    primary: Lead,
    operatorId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await this.repo.update(lead.id, { dupOfLeadId: primary.id }, tx);
    await this.repo.appendEvent(
      lead.id,
      LEAD_EVENT_KIND.DUP_LINKED,
      { primaryLeadId: primary.id },
      operatorId,
      tx,
    );
  }

  /** 落库时查重挂链＋统一 customerId（导入/手工登记共用，2026-08-25 从导入服务抽出）：
   * 命中主 Lead 则挂链；主 Lead 已有 customerId 则沿用，否则按主联系方式建 Customer 回填双方。
   * 返回是否判重（供调用方计数）。 */
  async linkAndUnify(
    lead: Lead,
    operatorId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const primary = await this.findDuplicates(
      { phone: lead.phone, wechat: lead.wechat },
      lead.id,
      tx,
    );
    if (!primary) return false;
    await this.linkDuplicate(lead, primary, operatorId, tx);
    if (primary.customerId) {
      await this.repo.update(lead.id, { customerId: primary.customerId }, tx);
    } else {
      const customer = await this.repo.findOrCreateCustomer(
        {
          name: primary.customerName ?? '未命名客户',
          phone: primary.phone,
          wechat: primary.wechat,
        },
        tx,
      );
      await this.repo.update(primary.id, { customerId: customer.id }, tx);
      await this.repo.update(lead.id, { customerId: customer.id }, tx);
    }
    return true;
  }

  /** 人工合并：次要（targetLeadId）并入主要（primaryId），只向下，不删除任何 Lead/事件。
   * 统一 customerId：主要方已有则沿用，否则按主要联系方式建 Customer 并回填双方。 */
  async mergeLeads(actor: JwtPayload, primaryId: string, secondaryId: string) {
    if (primaryId === secondaryId) {
      throw new AppException(ErrorCode.LEAD_INVALID_STATE, '不能将客资并入自身');
    }
    const primary = await this.repo.findById(primaryId);
    if (!primary) throw new AppException(ErrorCode.NOT_FOUND, '主客资不存在');
    const secondary = await this.repo.findById(secondaryId);
    if (!secondary) throw new AppException(ErrorCode.NOT_FOUND, '并入客资不存在');

    const customerId = await this.prisma.$transaction(async (tx) => {
      let cid = primary.customerId;
      if (!cid) {
        cid = (
          await this.repo.findOrCreateCustomer(
            {
              name: primary.customerName ?? '未命名客户',
              phone: primary.phone,
              wechat: primary.wechat,
            },
            tx,
          )
        ).id;
        await this.repo.update(primaryId, { customerId: cid }, tx);
      }
      await this.repo.update(secondaryId, { dupOfLeadId: primaryId, customerId: cid }, tx);
      await this.repo.appendEvent(
        primaryId,
        LEAD_EVENT_KIND.MERGED,
        { mergedLeadId: secondaryId },
        actor.sub,
        tx,
      );
      await this.repo.appendEvent(
        secondaryId,
        LEAD_EVENT_KIND.MERGED,
        { primaryLeadId: primaryId },
        actor.sub,
        tx,
      );
      return cid;
    });

    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'lead.merge',
      objectType: 'lead',
      objectId: primaryId,
      after: { mergedLeadId: secondaryId, customerId },
    });

    return { primaryLeadId: primaryId, mergedLeadId: secondaryId, customerId };
  }
}
