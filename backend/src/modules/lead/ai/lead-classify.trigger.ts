import { Injectable, Logger } from '@nestjs/common';
import type { Lead } from '@prisma/client';

import { AiDispatchService } from '../../ai-dispatch/ai-dispatch.service';
import { AiTaskRepository } from '../../ai-dispatch/ai-task.repository';
import { CustomerRefService } from '../../ai-dispatch/customer-ref.service';

/** lead.classify 触发（P3-07）：首次客户回复与沉默复活时同进程直调，构造脱敏上下文提交意向分级任务。
 * 幂等键＝lead.id：已有非终态 lead.classify 任务则跳过（重复回复/重复复活不产生重复任务）。
 * 本路径是「未确认不影响业务」的自动建议入口：所有异常内部吞掉只记 warn，绝不向调用方抛出，
 * 保证客户回复/复活等业务动作不被 AI 门禁（开关关闭/预算熔断/网关失败）阻断。 */
@Injectable()
export class LeadClassifyTrigger {
  private readonly logger = new Logger(LeadClassifyTrigger.name);

  constructor(
    private readonly dispatch: AiDispatchService,
    private readonly tasks: AiTaskRepository,
    private readonly customerRef: CustomerRefService,
  ) {}

  /** 客户回复/复活时触发分级（防御性：AI 开关关闭、预算熔断、提交失败均不抛，只记 warn）。 */
  async onReply(lead: Lead): Promise<void> {
    try {
      await this.submit(lead);
    } catch (err) {
      this.logger.warn(`客资 ${lead.id} 意向分级触发失败：${safeClassifyErrorText(err)}`);
    }
  }

  /** 分配成功后触发首次分级（2026-08-26 O8 评测缺口修复）：登记/导入完成分配即出分级建议，
   * 不再等首次客户回复。防御性同 onReply：异常吞掉只记 warn，绝不阻断分配业务。
   * 2026-08-27 全流程测试 #2 修复：改派不重跑——分配类事件输入未变（模型对同一事实多次
   * 判决会漂移，实测三次三结果），已有 done 建议即跳过；客户回复（onReply）= 新证据才允许重评。 */
  async onAssigned(lead: Lead): Promise<void> {
    try {
      if (lead.intentConfirmedBy) {
        this.logger.debug(`客资 ${lead.id} 意向已人工确认，跳过分配触发分级`);
        return;
      }
      const done = await this.tasks.findLatestDoneByRef('lead', lead.id, 'lead.classify');
      if (done) {
        this.logger.debug(`客资 ${lead.id} 已有分级建议，分配事件不重新分级`);
        return;
      }
      await this.submit(lead);
    } catch (err) {
      this.logger.warn(`客资 ${lead.id} 分配触发意向分级失败：${safeClassifyErrorText(err)}`);
    }
  }

  /** 幂等提交：已有非终态 lead.classify 任务则跳过；
   * 人工确认后的等级锁定（2026-08-27 #2③：确认写入的 intentLevel 不被后续任务的建议覆盖展示）。 */
  private async submit(lead: Lead): Promise<void> {
    if (lead.intentConfirmedBy) {
      this.logger.debug(`客资 ${lead.id} 意向已人工确认，跳过分级任务`);
      return;
    }
    const existing = await this.tasks.findNonTerminalByRef('lead', lead.id, 'lead.classify');
    if (existing) {
      this.logger.debug(`客资 ${lead.id} 已有未终态 lead.classify 任务，跳过重复触发`);
      return;
    }
    const refId = lead.customerId ? await this.customerRef.getOrCreate(lead.customerId) : lead.id;
    const context = {
      refId,
      sourcePlatform: lead.sourcePlatform,
      businessType: lead.businessType,
      target: lead.target ?? null,
      productNeed: lead.productNeed ?? null,
      rawNeed: lead.rawNeed ?? null,
      stage: lead.stage,
      lastFollowUpResult: lead.lastFollowUpResult ?? null,
      receivedAt: lead.receivedAt ?? null,
      firstCustomerReplyAt: lead.firstCustomerReplyAt ?? null,
    };
    await this.dispatch.submitTaskAutoRetry('lead.classify', context, {
      type: 'lead',
      id: lead.id,
    });
  }
}

/** 分级触发错误摘要脱敏：截断并把 5 位以上连续数字打码，防联系方式/凭证泄漏进日志（S04）。 */
function safeClassifyErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/\d{5,}/g, (m) => '*'.repeat(m.length)).slice(0, 200);
}
