import { Inject, Injectable } from '@nestjs/common';
// ModuleRef 须从 @nestjs/core 导入：@nestjs/common 的该导出是 CJS 动态挂载，
// vitest ESM interop 下 named import 不可见（运行时 undefined → DI 解析失败）
import { ModuleRef } from '@nestjs/core';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { JwtPayload } from '../auth/auth.types';
import { ApprovalService } from '../approval/approval.service';
import { APPROVAL_TYPE_KNOWLEDGE_ACTIVATE } from '../knowledge/knowledge.constants';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../../prisma/prisma.service';
import { bigramSimilarity } from './ai-usage.service';

/** 影子样本回流（阶段三 B2）：影子面板优质样本一键转经验卡建议。
 * 零 AI 成本——确定性拼卡直接走既有 createFromChat 通道（素材是对比样本非对话，
 * 不经 experience.extract 技能省 token）；落建议态草稿（status=draft）待老板审批生效。
 * P3-F03 修复（2026-09-08 phase3 评测实锤）：转卡即创建 knowledge.activate 审批单——
 * 此前只写草稿不建审批，「已入知识库待老板审批」的页面提示在审批中心无法兑现
 * （转卡前后待审批均 2 项，评测脚本另行 POST /approvals 才串通）。批准走
 * KnowledgeService 既有 handler → executeActivate 自动激活，学习闭环无需人工代庖。
 * 接线：KnowledgeModule 已 import 本模块（知识检索提交 AI 任务），再反向 import 会成
 * 模块环（vitest SSR 转换下元数据不稳），故经 ModuleRef 取全局 KnowledgeService/
 * ApprovalService 单例。 */
@Injectable()
export class ShadowHarvestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
  ) {}

  /** 全局容器的 KnowledgeService 单例（AppModule 全量启动，请求期必已就绪） */
  private knowledge(): KnowledgeService {
    return this.moduleRef.get(KnowledgeService, { strict: false });
  }

  /** 全局容器的 ApprovalService 单例（同 KnowledgeService 的 ModuleRef 取法） */
  private approval(): ApprovalService {
    return this.moduleRef.get(ApprovalService, { strict: false });
  }

  /** 转卡后建生效审批单（P3-F03）：payload 与 KnowledgeService.activate 的价格审批
   * 同构（itemId/kind/key/title），复用同一 knowledge.activate handler；审计动作沿用
   * knowledge.activate_requested（审批中心/看板计数口径一致），from 标记来源。 */
  private async requestActivateApproval(
    actor: JwtPayload,
    item: { id: string; kind: string; key: string; title: string },
  ): Promise<string> {
    const approval = await this.approval().create(actor, {
      type: APPROVAL_TYPE_KNOWLEDGE_ACTIVATE,
      payload: { itemId: item.id, kind: item.kind, key: item.key, title: item.title },
      basis: `影子样本回流经验卡生效审批：${item.title}`,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'knowledge.activate_requested',
      objectType: 'knowledge_item',
      objectId: item.id,
      after: { approvalId: approval.id, from: 'shadow-harvest' },
    });
    return approval.id;
  }

  /** 话术对比样本转卡：按 taskId 重查 ai_tasks.output.message 全文（面板 80 截断仅展示用）
   * + 同 taskId 最新 draft_created 事件的人工实发（无改写=照发，实发=原文），
   * 三段中文标签确定性拼装（AI 草稿全文 / 人工实发全文 / 2-gram Dice 相似度）。 */
  async harvestDraft(
    actor: JwtPayload,
    input: { taskId: string },
  ): Promise<{
    id: string;
    kind: string;
    status: string;
    title: string;
    source: string | null;
    approvalId: string;
  }> {
    if (!input.taskId?.trim()) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, '缺少 taskId');
    }
    const task = await this.prisma.aiTask.findUnique({
      where: { id: input.taskId },
      select: { taskType: true, output: true },
    });
    if (!task || task.taskType !== 'sales.draft_message') {
      throw new AppException(ErrorCode.VALIDATION_FAILED, '话术草稿任务不存在');
    }
    const out = task.output as { message?: unknown } | null;
    const original = typeof out?.message === 'string' ? out.message : '';
    if (!original) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, '该任务无草稿正文，无法转卡');
    }
    const editEvent = await this.prisma.leadEvent.findFirst({
      where: { kind: 'draft_created', content: { path: ['taskId'], equals: input.taskId } },
      orderBy: { occurredAt: 'desc' },
      select: { content: true },
    });
    const editText = (editEvent?.content as { text?: unknown } | null)?.text;
    const actual = typeof editText === 'string' && editText ? editText : original; // 无改写=照发
    const similarity = Number(bigramSimilarity(original, actual).toFixed(3));
    const item = await this.knowledge().createFromChat(actor, {
      kind: 'sales_method',
      title: `影子样本·话术对比 ${cnDateLabel()}`,
      content: [
        '【AI 草稿】',
        original,
        '',
        '【人工实发】',
        actual,
        '',
        `【相似度】${similarity}（2-gram Dice；≥0.999＝照发未改写）`,
      ].join('\n'),
      sourceLabel: '影子样本回流',
    });
    const approvalId = await this.requestActivateApproval(actor, item);
    return {
      id: item.id,
      kind: item.kind,
      status: item.status,
      title: item.title,
      source: item.source,
      approvalId,
    };
  }

  /** 意向改判样本转卡：AI 判级 / 人工判级 / 改判理由三段；附客资编号便于老板溯源审批。 */
  async harvestIntent(
    actor: JwtPayload,
    input: { leadId: string; aiLevel: string; humanLevel: string; reason?: string },
  ): Promise<{
    id: string;
    kind: string;
    status: string;
    title: string;
    source: string | null;
    approvalId: string;
  }> {
    if (!input.leadId?.trim()) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, '缺少 leadId');
    }
    const lead = await this.prisma.lead.findUnique({
      where: { id: input.leadId },
      select: { leadNo: true },
    });
    if (!lead) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, '客资不存在');
    }
    const item = await this.knowledge().createFromChat(actor, {
      kind: 'sales_method',
      title: `影子样本·意向改判 ${cnDateLabel()}`,
      content: [
        `【AI 判级】${input.aiLevel}`,
        `【人工判级】${input.humanLevel}`,
        `【改判理由】${input.reason?.trim() || '（未填写）'}`,
        '',
        `客资编号：${lead.leadNo}`,
      ].join('\n'),
      sourceLabel: '影子样本回流',
    });
    const approvalId = await this.requestActivateApproval(actor, item);
    return {
      id: item.id,
      kind: item.kind,
      status: item.status,
      title: item.title,
      source: item.source,
      approvalId,
    };
  }
}

/** 标题日期标签「M月D日」（本地时区当天，与面板样本观察窗一致） */
function cnDateLabel(): string {
  const now = new Date();
  return `${now.getMonth() + 1}月${now.getDate()}日`;
}
