import { Injectable, Logger } from '@nestjs/common';
import type { Lead } from '@prisma/client';

import { AiDispatchService } from '../../ai-dispatch/ai-dispatch.service';
import { AiTaskRepository } from '../../ai-dispatch/ai-task.repository';
import { CustomerRefService } from '../../ai-dispatch/customer-ref.service';

/** lead.summary 触发（P3-05）：分配成功后同进程直调，构造脱敏上下文提交 AI 摘要任务。
 * 幂等键＝lead.id：已有非终态 lead.summary 任务则跳过（重复分配事件不产生重复任务）。
 * 上下文只含 refId/sourcePlatform/businessType/target/productNeed/rawNeed/stage/lastFollowUpResult，
 * 绝不含电话/微信/chatLink（maskDeep 在通道边界对 rawNeed 等自由文本二次兜底）。 */
@Injectable()
export class LeadSummaryTrigger {
  private readonly logger = new Logger(LeadSummaryTrigger.name);

  constructor(
    private readonly dispatch: AiDispatchService,
    private readonly tasks: AiTaskRepository,
    private readonly customerRef: CustomerRefService,
  ) {}

  /** 分配成功后触发摘要。接收完整 Lead 对象（兼容导入事务内调用：事务未提交时按 id 反查读不到）。
   * AI_DISABLED/预算门禁/提交失败等异常向调用方抛出，由调用方（AssignService）决定是否阻断业务。 */
  async onAssigned(lead: Lead): Promise<void> {
    const existing = await this.tasks.findNonTerminalByRef('lead', lead.id, 'lead.summary');
    if (existing) {
      this.logger.debug(`客资 ${lead.id} 已有未终态 lead.summary 任务，跳过重复触发`);
      return;
    }
    const context = await this.buildContext(lead);
    await this.dispatch.submitTaskAutoRetry('lead.summary', context, { type: 'lead', id: lead.id });
  }

  /** 手动重提（2026-08-26 O8 评测缺口）：非终态任务存在则直接返回它（幂等，不重复提交）；
   * 否则按当前客资上下文重提——上下文可能已比失败那次更新（如期间补了跟进记录）。 */
  async regenerate(lead: Lead): Promise<{ taskId: string; status: string }> {
    const existing = await this.tasks.findNonTerminalByRef('lead', lead.id, 'lead.summary');
    if (existing) return { taskId: existing.id, status: existing.status };
    const context = await this.buildContext(lead);
    const task = await this.dispatch.submitTaskAutoRetry('lead.summary', context, {
      type: 'lead',
      id: lead.id,
    });
    return { taskId: task.id, status: task.status };
  }

  /** 脱敏上下文构造（onAssigned/regenerate 共用）。 */
  private async buildContext(lead: Lead) {
    // 客户以 refId 假名参与（A04）：有 customer 走映射，无 customer 用 lead.id 作 referent（非 PII）
    const refId = lead.customerId ? await this.customerRef.getOrCreate(lead.customerId) : lead.id;
    return {
      refId,
      sourcePlatform: lead.sourcePlatform,
      businessType: lead.businessType,
      target: lead.target ?? null,
      productNeed: lead.productNeed ?? null,
      rawNeed: lead.rawNeed ?? null,
      stage: lead.stage,
      lastFollowUpResult: lead.lastFollowUpResult ?? null,
    };
  }
}
