import { Injectable } from '@nestjs/common';
import type { Lead } from '@prisma/client';

import { AiTaskRepository } from '../../ai-dispatch/ai-task.repository';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { PrismaService } from '../../../prisma/prisma.service';
import type { JwtPayload } from '../../auth/auth.types';
import { LeadRepository } from '../lead.repository';
import { LeadService } from '../lead.service';
import {
  LeadSummaryOutputSchema,
  type LeadSummaryOutput,
  leadAiProgressOf,
  type LeadAiProgress,
} from './lead-ai.module';
import { LeadSummaryTrigger } from './lead-summary.trigger';

/** 摘要展示返回体（建议态）：taskId 供前端 feedback 定位；输出字段经 Zod 校验后展开。
 * feedback 为最近一次人工反馈概要（2026-08-25 老板反馈「按钮无反应」——详情页回显状态用）。 */
export interface LeadSummaryView extends LeadSummaryOutput {
  taskId: string;
  createdAt: Date;
  feedback?: { decision: string; note: string | null; createdAt: Date } | null;
}

/** 摘要状态视图（2026-08-26 O8 评测缺口）：status=最新一次任务的进度（none=从未生成），
 * summary=最新 done 任务的输出（最新一次失败时仍展示旧摘要，前端同时提示失败可重试）。
 * 详情页据此轮询刷新——登记后 8~20 秒出结果，此前返回 pending。 */
export interface LeadSummaryStatusView {
  status: LeadAiProgress;
  summary: LeadSummaryView | null;
}

/** lead.summary 读侧与反馈（P3-05）：GET 取最新 done 任务 output；POST 写 ai_task_feedback。
 * 输出只读建议态，绝不回写业务字段；反馈落 ai_task_feedback（M11 学习链数据源）。 */
@Injectable()
export class LeadSummaryService {
  constructor(
    private readonly tasks: AiTaskRepository,
    private readonly repo: LeadRepository,
    private readonly leads: LeadService,
    private readonly prisma: PrismaService,
    private readonly trigger: LeadSummaryTrigger,
  ) {}

  /** 摘要状态视图（2026-08-26 O8 评测缺口）：进度看最新一条任务（任意状态），
   * 内容兜底取最新 done——最新一次 degraded/failed 时 status 报失败但仍回旧摘要供参考。
   * 数据范围强制（红线）：负责人本人或 boss/store_manager 全局角色，否则 LEAD_NOT_OWNER。 */
  async getSummary(leadId: string, actor: JwtPayload): Promise<LeadSummaryStatusView> {
    await this.getOwnedLead(leadId, actor);
    const latest = await this.tasks.findLatestByRef('lead', leadId, 'lead.summary');
    if (!latest) return { status: 'none', summary: null };
    const status = leadAiProgressOf(latest.status);
    const done =
      latest.status === 'done'
        ? latest
        : await this.tasks.findLatestDoneByRef('lead', leadId, 'lead.summary');
    if (!done?.output) return { status, summary: null };
    const parsed = LeadSummaryOutputSchema.safeParse(done.output);
    if (!parsed.success) return { status, summary: null }; // 已落库输出必已通过校验，防御性兜底
    // 回显最近一次反馈（同 lead 换代摘要后旧反馈不跨任务展示）
    const fb = await this.prisma.aiTaskFeedback.findFirst({
      where: { taskId: done.id },
      orderBy: { createdAt: 'desc' },
      select: { decision: true, note: true, createdAt: true },
    });
    return {
      status,
      summary: {
        taskId: done.id,
        createdAt: done.createdAt,
        feedback: fb ?? null,
        ...parsed.data,
      },
    };
  }

  /** 手动重提摘要（2026-08-26 O8 评测缺口）：归属校验后调 trigger.regenerate（非终态幂等）。 */
  async regenerate(leadId: string, actor: JwtPayload): Promise<{ taskId: string; status: string }> {
    const lead = await this.getOwnedLead(leadId, actor);
    return this.trigger.regenerate(lead);
  }

  /** 员工对最新摘要标记采用/修改/拒绝，写 ai_task_feedback；无摘要可反馈则 NOT_FOUND。 */
  async submitFeedback(
    leadId: string,
    actor: JwtPayload,
    body: { decision: string; note?: string | null },
  ): Promise<{ id: string; taskId: string; decision: string; createdAt: Date }> {
    await this.getOwnedLead(leadId, actor);
    const task = await this.tasks.findLatestDoneByRef('lead', leadId, 'lead.summary');
    if (!task) {
      throw new AppException(ErrorCode.NOT_FOUND, '该客资尚无 AI 摘要可反馈');
    }
    const fb = await this.tasks.createFeedback({
      taskId: task.id,
      decision: body.decision,
      note: body.note ?? null,
      userId: actor.sub,
    });
    return { id: fb.id, taskId: fb.taskId, decision: fb.decision, createdAt: fb.createdAt };
  }

  /** 负责人或全局角色校验后返回客资（对齐 lead.classify / sales.draft 的 getOwnedLead 同款做法）。 */
  private async getOwnedLead(leadId: string, actor: JwtPayload): Promise<Lead> {
    const lead = await this.repo.findById(leadId);
    if (!lead) throw new AppException(ErrorCode.NOT_FOUND, '客资不存在');
    await this.leads.assertOwnerOrGlobal(actor, lead);
    return lead;
  }
}
