import { Injectable, Logger } from '@nestjs/common';
import type { Lead, Prisma } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../auth/auth.types';
import { LeadSummaryTrigger } from './ai/lead-summary.trigger';
import { withLlmCap } from './ai/trigger-cap.util';
import { LeadClassifyTrigger } from './ai/lead-classify.trigger';
import { AssignService, isWalkInLead } from './assign.service';
import { LEAD_EVENT_KIND } from './lead.constants';
import { DedupService } from './dedup.service';
import { KeyedLock } from './import-lock';
import { normalizePhone, normalizeWechat } from './lead.normalize';
import { LeadRepository } from './lead.repository';
import type { ManualRegisterDto } from './lead.dto';

/** 手工登记客资（2026-08-25 老板需求）：字段口径=客资字段字典 17 列导入子集（英文枚举直存，
 * 无中文表头映射层）。登记即入库（无导入批次，batchId 留空），复用导入管线同款：
 * 归一化联系方式查重挂链（linkAndUnify）＋分派池自动路由（AssignService.route）＋
 * 事务提交后触发 AI 摘要（P3-05 fix round 1 口径）。
 * 负责人：可选指定（登记时直接落 owner 并记 assigned 事件），默认自动路由；
 * 到店类不自动分配待接待人认领（与导入一致，isWalkInLead）。 */
@Injectable()
export class LeadManualService {
  private readonly logger = new Logger(LeadManualService.name);

  /** 去重临界区进程内互斥（与导入共用口径：同归一化联系方式串行） */
  private readonly lock = new KeyedLock();

  constructor(
    private readonly repo: LeadRepository,
    private readonly prisma: PrismaService,
    private readonly dedup: DedupService,
    private readonly assign: AssignService,
    private readonly audit: AuditService,
    private readonly summary: LeadSummaryTrigger,
    private readonly classify: LeadClassifyTrigger,
  ) {}

  /** 可指定负责人清单（GET /leads/assignable-users）：在职 boss/店长/销售
   * （与分派池同角色宇宙）；/system/users 需 system:manage，销售登记时不可用，故单列。 */
  async assignableUsers(): Promise<Array<{ id: string; username: string; displayName: string }>> {
    return this.prisma.user.findMany({
      where: {
        disabled: false,
        // 2026-08-28 bug5：ph-* 为种子占位账号（无真人口令交付），不进跟进人下拉
        username: { not: { startsWith: 'ph-' } },
        userRoles: { some: { role: { code: { in: ['boss', 'store_manager', 'sales_ops'] } } } },
      },
      select: { id: true, username: true, displayName: true },
      orderBy: { username: 'asc' },
    });
  }

  /** 实时查重（GET /leads/dup-check，登记表单电话/微信失焦时调用）：
   * 返回疑似主客资的概要信息（不含联系方式明文，避免越权遍历）。 */
  async dupCheck(query: { phone?: string; wechat?: string }): Promise<{
    duplicate: boolean;
    lead?: {
      id: string;
      leadNo: string;
      customerName: string | null;
      stage: string;
      receivedAt: Date;
    };
  }> {
    if (!query.phone && !query.wechat) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, '电话与微信至少提供一项');
    }
    const primary = await this.dedup.findDuplicates(query);
    if (!primary) return { duplicate: false };
    return {
      duplicate: true,
      lead: {
        id: primary.id,
        leadNo: primary.leadNo,
        customerName: primary.customerName,
        stage: primary.stage,
        receivedAt: primary.receivedAt,
      },
    };
  }

  /** 手工登记（POST /leads）：单事务建 Lead＋manual_registered 事件＋查重挂链＋负责人路由；
   * 成功后（事务外）触发摘要并审计。返回落库后的完整 Lead。 */
  async register(actor: JwtPayload, dto: ManualRegisterDto): Promise<Lead> {
    // 指定负责人存在性校验（老板口径：可选指定、默认自动）
    let explicitOwnerId: string | null = null;
    if (dto.ownerUserId) {
      const owner = await this.prisma.user.findUnique({
        where: { id: dto.ownerUserId },
        select: {
          id: true,
          disabled: true,
          userRoles: { select: { role: { select: { code: true } } } },
        },
      });
      if (!owner) throw new AppException(ErrorCode.NOT_FOUND, '指定负责人不存在');
      if (
        owner.disabled ||
        !owner.userRoles.some(({ role }) =>
          ['boss', 'store_manager', 'sales_ops'].includes(role.code),
        )
      ) {
        throw new AppException(
          ErrorCode.VALIDATION_FAILED,
          '指定负责人必须是在职的老板、店长或销售运营',
        );
      }
      explicitOwnerId = owner.id;
    }

    const keys: string[] = [];
    if (dto.phone) keys.push(normalizePhone(dto.phone));
    if (dto.wechat) keys.push(normalizeWechat(dto.wechat));

    let leadId = '';
    let assigned = false;
    await this.lock.runAll(keys, async () => {
      await this.prisma.$transaction(async (tx) => {
        const lead = await this.repo.create(this.toLeadData(dto), tx);
        leadId = lead.id;
        await this.repo.appendEvent(
          lead.id,
          LEAD_EVENT_KIND.MANUAL_REGISTERED,
          { by: actor.username },
          actor.sub,
          tx,
        );
        await this.dedup.linkAndUnify(lead, actor.sub, tx);

        if (explicitOwnerId) {
          await this.repo.update(
            lead.id,
            { ownerUserId: explicitOwnerId, assignedAt: new Date() },
            tx,
          );
          await this.repo.appendEvent(
            lead.id,
            LEAD_EVENT_KIND.ASSIGNED,
            { reason: '手工登记指定负责人', by: actor.username },
            actor.sub,
            tx,
          );
          assigned = true;
          return;
        }
        // 默认自动路由：route 自带「重复沿用原负责人/转介绍回原维护人/池轮询/老板兜底」；
        // 到店类返回 null（待接待人认领），与导入侧口径一致
        if (
          isWalkInLead({
            sourcePlatform: lead.sourcePlatform,
            acquisitionMethod: lead.acquisitionMethod,
          })
        ) {
          await this.repo.appendEvent(
            lead.id,
            LEAD_EVENT_KIND.ASSIGNED,
            { reason: '到店客资待接待人手工认领' },
            actor.sub,
            tx,
          );
          return;
        }
        try {
          const result = await this.assign.route(lead, tx);
          assigned = result.ownerUserId !== null;
          if (!result.ownerUserId) {
            await this.repo.appendEvent(
              lead.id,
              LEAD_EVENT_KIND.ASSIGNED,
              { reason: '未分配待兜底' },
              actor.sub,
              tx,
            );
          }
        } catch (err) {
          // 分配异常不阻断登记，但可观测（脱敏摘要，S04）
          this.logger.warn(
            `客资 ${lead.leadNo}(${lead.id}) 自动分配失败，留空待兜底：${safeErrorText(err)}`,
          );
          await this.repo.appendEvent(
            lead.id,
            LEAD_EVENT_KIND.ASSIGNED,
            { reason: '未分配待兜底' },
            actor.sub,
            tx,
          );
        }
      });
    });

    // 摘要+首次意向分级触发移出事务（P3-05 fix round 1 同口径）：仅已分配客资触发。
    // 2026-08-27 全流程测试 #1：封顶等待 3 秒——真实网关双任务串行 20~45 秒会让登记接口
    // 挂起诱发超时重发；任务后台继续跑，详情页状态视图轮询展示「生成中→完成」。
    if (assigned) {
      await withLlmCap(
        (async () => {
          const fresh = await this.repo.findById(leadId);
          if (!fresh) return;
          await this.summary.onAssigned(fresh);
          await this.classify.onAssigned(fresh);
        })(),
      );
    }

    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'lead.manual_registered',
      objectType: 'lead',
      objectId: leadId,
      after: { explicitOwner: explicitOwnerId !== null },
    });

    const created = await this.repo.findById(leadId);
    if (!created) throw new AppException(ErrorCode.INTERNAL, '登记结果读取失败');
    return created;
  }

  /** 登记载荷 → Lead 落库字段（英文枚举直存；receivedAt=登记时刻=SLA 起点） */
  private toLeadData(dto: ManualRegisterDto): Omit<Prisma.LeadUncheckedCreateInput, 'leadNo'> {
    return {
      sourceCategory: dto.sourceCategory,
      sourcePlatform: dto.sourcePlatform,
      operatorEntity: dto.operatorEntity,
      acquisitionMethod: dto.acquisitionMethod,
      upstreamDispatchNo: dto.upstreamDispatchNo,
      adPlanText: dto.adPlanText,
      contentId: dto.contentId,
      chatLink: dto.chatLink,
      customerName: dto.customerName,
      phone: dto.phone,
      wechat: dto.wechat,
      wechatType: dto.wechatType ?? 'unknown',
      businessType: dto.businessType ?? 'auto_film',
      target: dto.target,
      productNeed: dto.productNeed,
      rawNeed: dto.rawNeed,
      remark: dto.remark,
      receivedAt: new Date(),
    };
  }
}

/** 错误摘要脱敏：截断并把 5 位以上连续数字打码（lead-import.service 同口径） */
function safeErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/\d{5,}/g, (m) => '*'.repeat(m.length)).slice(0, 200);
}
