import { Injectable } from '@nestjs/common';
import type { AiTask, LeadEvent } from '@prisma/client';

import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import type { JwtPayload } from '../../auth/auth.types';
import { AiDispatchService } from '../../ai-dispatch/ai-dispatch.service';
import { AiTaskRepository } from '../../ai-dispatch/ai-task.repository';
import { CustomerRefService } from '../../ai-dispatch/customer-ref.service';
import { LEAD_EVENT_KIND } from '../lead.constants';
import { LeadRepository } from '../lead.repository';
import { LeadService } from '../lead.service';
import { LeadDraftOutputSchema } from './lead-ai.module';

/** 提交草稿任务返回体（建议态）：status 可能为 done/degraded（AI 开关关闭/预算熔断/校验失败） */
export interface DraftView {
  taskId: string;
  status: string;
  message: string | null;
  notes: string | null;
  createdAt: Date;
}

/** 历史草稿列表项：AI 原建议（source='ai'）与人工作业改写（source='human_edit'）统一视图。
 * 四件事分离：AI 建议只落 ai_tasks.output；人工改写只落 draft_created 事件，绝不回写 output。 */
export interface DraftListItem {
  taskId: string;
  version: number;
  text: string;
  source: 'ai' | 'human_edit';
  notes: string | null;
  createdAt: Date;
}

/** 草稿事件 content 契约（P3-06）：draft_created 存 {taskId, version, text, source:'human_edit'}；
 * draft_copied 存 {taskId}；send_recorded 存 {taskId, sendEvidence}。
 * type 别名而非 interface：对象字面量类型可赋给 appendEvent 的 Record<string, unknown> 参数。 */
type DraftCreatedContent = {
  taskId: string;
  version: number;
  text: string;
  source: 'human_edit';
};

/**
 * sales.draft_message 草稿工作区（P3-06）：草稿生成/人工改写/一键复制/记录发送/历史列表。
 * 全部写动作走 m03:edit + assertOwnerOrGlobal；「已复制」≠「已发送」：
 * copy 只写 draft_copied 事件，服务端无任何由 copied 推导 sent 的代码路径；
 * 实际发送必须带 sendEvidence（min 10）写 send_recorded 事件并同步 lastFollowUpResult。
 * 无对外出口：本服务只写 ai_tasks/lead_events/lead 字段，不发起任何对外 HTTP/队列/发送副作用。
 */
@Injectable()
export class SalesDraftService {
  constructor(
    private readonly dispatch: AiDispatchService,
    private readonly tasks: AiTaskRepository,
    private readonly repo: LeadRepository,
    private readonly leads: LeadService,
    private readonly customerRef: CustomerRefService,
  ) {}

  /** 提交草稿任务：构造脱敏上下文（refId 假名＋业务字段＋本轮目标）走 submitTask 同步闭环。
   * 偶发降级自动重试一次（2026-08-27 O8 复评：degraded/message=null 重试即成功——模型偶发
   * 空输出/漂移形态，重放一次成本极小，免去销售手动重点）；重试仍失败则如实返回 degraded。 */
  async submitDraft(leadId: string, actor: JwtPayload, goal?: string): Promise<DraftView> {
    const lead = await this.getOwnedLead(leadId, actor);
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
      goal: goal ?? null,
    };
    // submitTaskAutoRetry（2026-08-27 #4）：降级自动重试一次已上移通用层（原先本服务自带同款逻辑）
    const task = await this.dispatch.submitTaskAutoRetry('sales.draft_message', context, {
      type: 'lead',
      id: leadId,
    });
    return this.toDraftView(task);
  }

  /** 销售改写：校验任务归属后写 draft_created 事件（不改 ai_tasks.output，AI 原建议原样保留）。 */
  async editDraft(
    leadId: string,
    taskId: string,
    actor: JwtPayload,
    text: string,
  ): Promise<DraftCreatedContent> {
    await this.getOwnedDraftTask(leadId, taskId, actor);
    const existing = await this.repo.findEventsByLeadAndKind(leadId, LEAD_EVENT_KIND.DRAFT_CREATED);
    const version = existing.length + 1;
    const content: DraftCreatedContent = { taskId, version, text, source: 'human_edit' };
    await this.repo.appendEvent(leadId, LEAD_EVENT_KIND.DRAFT_CREATED, content, actor.sub);
    return content;
  }

  /** 一键复制：仅写 draft_copied 事件。服务端不推导 sent，不更新任何业务字段（A10：已复制≠已发送）。 */
  async copyDraft(leadId: string, taskId: string, actor: JwtPayload): Promise<{ taskId: string }> {
    await this.getOwnedDraftTask(leadId, taskId, actor);
    await this.repo.appendEvent(leadId, LEAD_EVENT_KIND.DRAFT_COPIED, { taskId }, actor.sub);
    return { taskId };
  }

  /** 记录发送：sendEvidence（min 10，聊天导入片段）必填；写 send_recorded 事件＋同步 lastFollowUpResult。 */
  async recordSend(
    leadId: string,
    taskId: string,
    actor: JwtPayload,
    sendEvidence: string,
  ): Promise<{ taskId: string; lastFollowUpResult: string }> {
    await this.getOwnedDraftTask(leadId, taskId, actor);
    await this.repo.appendEvent(
      leadId,
      LEAD_EVENT_KIND.SEND_RECORDED,
      { taskId, sendEvidence },
      actor.sub,
    );
    await this.repo.update(leadId, { lastFollowUpResult: sendEvidence });
    return { taskId, lastFollowUpResult: sendEvidence };
  }

  /** 历史草稿列表：AI 原建议（done 任务 output）＋人工作业改写（draft_created 事件）合并倒序。 */
  async listDrafts(leadId: string, actor: JwtPayload): Promise<DraftListItem[]> {
    await this.getOwnedLead(leadId, actor);
    const [tasks, edits] = await Promise.all([
      this.tasks.findDoneByRef('lead', leadId, 'sales.draft_message'),
      this.repo.findEventsByLeadAndKind(leadId, LEAD_EVENT_KIND.DRAFT_CREATED),
    ]);

    const aiDrafts: DraftListItem[] = tasks.flatMap((task) => {
      const parsed = LeadDraftOutputSchema.safeParse(task.output);
      if (!parsed.success) return [];
      return [
        {
          taskId: task.id,
          version: 0,
          text: parsed.data.message,
          source: 'ai' as const,
          notes: parsed.data.notes ?? null,
          createdAt: task.createdAt,
        },
      ];
    });

    const humanEdits: DraftListItem[] = edits.flatMap((event) => {
      const content = parseDraftCreated(event);
      if (!content) return [];
      return [
        {
          taskId: content.taskId,
          version: content.version,
          text: content.text,
          source: 'human_edit' as const,
          notes: null,
          createdAt: event.occurredAt,
        },
      ];
    });

    return [...aiDrafts, ...humanEdits].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  /** 负责人或全局校验后返回客资。 */
  private async getOwnedLead(leadId: string, actor: JwtPayload) {
    const lead = await this.repo.findById(leadId);
    if (!lead) throw new AppException(ErrorCode.NOT_FOUND, '客资不存在');
    await this.leads.assertOwnerOrGlobal(actor, lead);
    return lead;
  }

  /** 校验草稿任务归属：refType='lead' 且 refId=leadId 且 taskType='sales.draft_message'；
   * 归属不符一律 NOT_FOUND（不泄露他人任务存在性）。 */
  private async getOwnedDraftTask(
    leadId: string,
    taskId: string,
    actor: JwtPayload,
  ): Promise<AiTask> {
    await this.getOwnedLead(leadId, actor);
    const task = await this.tasks.findById(taskId);
    if (
      !task ||
      task.refType !== 'lead' ||
      task.refId !== leadId ||
      task.taskType !== 'sales.draft_message'
    ) {
      throw new AppException(ErrorCode.NOT_FOUND, '草稿任务不存在或不属于该客资');
    }
    return task;
  }

  /** AiTask → 草稿视图：done 时解 output 取 message/notes；degraded/failed 时 message=null。 */
  private toDraftView(task: AiTask): DraftView {
    const parsed = task.output ? LeadDraftOutputSchema.safeParse(task.output) : null;
    const output = parsed?.success ? parsed.data : null;
    return {
      taskId: task.id,
      status: task.status,
      message: output?.message ?? null,
      notes: output?.notes ?? null,
      createdAt: task.createdAt,
    };
  }
}

/** 从 lead_events.content 防御性解析 draft_created 结构（Json 可能为空/畸形，不抛）。 */
function parseDraftCreated(event: LeadEvent): DraftCreatedContent | null {
  const content = event.content as DraftCreatedContent | null;
  if (
    !content ||
    typeof content.taskId !== 'string' ||
    typeof content.version !== 'number' ||
    typeof content.text !== 'string' ||
    content.source !== 'human_edit'
  ) {
    return null;
  }
  return content;
}
