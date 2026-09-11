import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { AiDispatchModule } from '../../ai-dispatch/ai-dispatch.module';
import { AiTaskRegistry } from '../../ai-dispatch/ai-dispatch.registry';
import { lintAgentOutput, type LintResult } from '../../ai-dispatch/output-lint';
import { LeadClassifyTrigger } from './lead-classify.trigger';
import { LeadSummaryTrigger } from './lead-summary.trigger';
import { normalizeLeadClassify, normalizeLeadDraft, normalizeLeadSummary } from './lead-normalize';

/** lead.summary 输出 schema（P3-05）：摘要/关注点/应问问题/建议下一动作/到店理由/升级时机建议。
 * 即回调校验依据（沿用 P2 注册表机制）；输出只落 ai_tasks.output 建议态，绝不写业务字段。 */
export const LeadSummaryOutputSchema = z.object({
  summary: z.string().min(1), // 客户情况摘要
  concerns: z.array(z.string()).default([]), // 关注点
  questionsToAsk: z.array(z.string()).default([]), // 应问问题
  nextAction: z.string().min(1), // 建议下一动作
  visitPitch: z.string().optional(), // 到店理由
  escalationHint: z.string().optional(), // 升级时机建议
});

export type LeadSummaryOutput = z.infer<typeof LeadSummaryOutputSchema>;

/** sales.draft_message 输出 schema（P3-06）：message=草稿正文（必填非空），notes=给销售的备注（可选）。
 * 即回调校验依据；输出只落 ai_tasks.output 建议态，绝不写业务字段、绝无对外发送出口。 */
export const LeadDraftOutputSchema = z.object({
  message: z.string().min(1),
  notes: z.string().optional(),
});

export type LeadDraftOutput = z.infer<typeof LeadDraftOutputSchema>;

/** sales.draft_message 行为边界（A06＋D-P3-13）：完整禁令随 constraints 下发给模型。
 * 四件事分离的前提：AI 只产出「建议/草稿」文本，是否复制/实际发送/客户结果均由人工动作留痕。 */
export const DRAFT_CONSTRAINTS = {
  boundary:
    '你是门店销售助理，以销售本人口吻起草微信跟进消息。禁止冒充老板身份、禁止粗口、禁止夸张奉承、禁止操纵式表达、禁止猜价或报出任何具体金额、禁止越权优惠、禁止收定金、禁止承诺质保/工期/赠品；涉及价格话题一律引导到店或转人工报价。输出为建议态草稿，仅进入 ai_tasks.output，不得触发任何对外动作。',
};

/** lead.classify 输出 schema（P3-07）：level=意向等级、confidence=置信度、evidence=证据、
 * missingInfo=缺失信息、nextAction=建议下一动作。即回调校验依据；输出只落 ai_tasks.output 建议态，
 * 绝不写业务字段（未人工确认不影响排序/分配/兜底）。 */
export const LeadClassifyOutputSchema = z.object({
  level: z.enum(['high', 'mid', 'low', 'pending']),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).default([]),
  missingInfo: z.array(z.string()).default([]),
  nextAction: z.string().optional(),
});

export type LeadClassifyOutput = z.infer<typeof LeadClassifyOutputSchema>;

/** AI 建议进度视图（2026-08-26 O8 评测缺口）：none=从未生成；pending=在途或未闭环
 * （pending/dispatched/running/callback_received/validated/failed/timeout 统一视为生成中——
 * failed 仍可迁移 degraded，timeout 为保留态，对用户均表现为「等结果」）；
 * done/degraded/cancelled=已定（终态口径对齐 AI_TASK_TERMINAL）。 */
export type LeadAiProgress = 'none' | 'pending' | 'done' | 'degraded' | 'cancelled';

/** 成交级信号确定性规则（2026-08-27 第二轮回归 #9 实锤：模型证据里写明「按规则直接判 high」
 * 结论字段却输出 pending——提示词是概率约束，门店定级口径用代码保证）：
 * 上下文（rawNeed/lastFollowUpResult）命中成交级信号而模型结论不是 high → 校正为 high，
 * 置信度抬到 ≥0.75，证据追加校正说明（可审计）。返回 null 表示无需校正。 */
const DEAL_SIGNAL_RE =
  /(付了?定金|已付定金|定金\d|\d+元?定金|提车|交车|到店施工|约定到店|预约(到店|施工))/;

export function applyDealSignalRule(
  context: { rawNeed?: string | null; lastFollowUpResult?: string | null },
  output: { level?: unknown; confidence?: unknown; evidence?: unknown },
): {
  level: string;
  confidence: number;
  evidence: string[];
  missingInfo: string[];
  nextAction?: string;
} | null {
  const text = `${context.rawNeed ?? ''} ${context.lastFollowUpResult ?? ''}`;
  if (!DEAL_SIGNAL_RE.test(text)) return null;
  if (output.level === 'high') return null;
  const evidence = Array.isArray(output.evidence)
    ? output.evidence.filter((e): e is string => typeof e === 'string')
    : [];
  evidence.push(
    '规则校正：上下文含成交级信号（明确提车/施工时间或定金），按门店定级口径直接判 high（提示词规则的概率性兜底）',
  );
  const nextAction =
    typeof (output as { nextAction?: unknown }).nextAction === 'string'
      ? (output as { nextAction?: string }).nextAction
      : undefined;
  return {
    level: 'high',
    confidence: Math.max(typeof output.confidence === 'number' ? output.confidence : 0.5, 0.75),
    evidence,
    missingInfo: [],
    ...(nextAction ? { nextAction } : {}),
  };
}

export function leadAiProgressOf(taskStatus: string): LeadAiProgress {
  if (taskStatus === 'done') return 'done';
  if (taskStatus === 'degraded') return 'degraded';
  if (taskStatus === 'cancelled') return 'cancelled';
  return 'pending';
}

/** lead.classify 约束（P3-07 字段字典 §4 意向段）：行为边界＋证据口径随 constraints 下发。
 * 证据口径（2026-08-27 O8 复评修复：高档保守）：成交级信号（付定金/已成交/明确提车施工时间/
 * 已约定到店）直接判 high——复评实据：证据列表明明有「月底提车/明天提车/付定金」仍判 pending 50%。 */
export const CLASSIFY_CONSTRAINTS = {
  boundary:
    '你是门店销售助理，仅依据给定脱敏客资上下文与最近对话摘要对客户意向分级，输出为建议态，只进入 ai_tasks.output，绝不写业务字段、不报价、不臆造事实、不使用任何工具。',
  evidenceCaliber:
    '定级规则（必须遵守）：①出现任一成交级信号——已付定金/已成交、明确的提车或施工时间（如「明天提车」「月底提车」「下周提车」——客户说出具体时间即算，无需已进入排期沟通）、双方已约定到店或施工——直接判 high，confidence≥0.75，不得因还有缺失信息而降为 pending（missingInfo 照常列出，不影响等级）；②有明确车型+产品需求、或主动问价问档期但无成交级信号——判 mid，confidence 约 0.6~0.7；③仅初步接触、无强证据——判 low 或 pending（pending 须在 missingInfo 列出待补项）。回复速度快慢仅为弱信号，不得作为定级主依据。',
};

/** lead.summary 注册（P3-05）：OnModuleInit 向全局注册表登记 taskType，
 * 不改 AiTaskRegistry 构造函数（P2 架构约定——业务 skill 随模块落地时在此追加）。 */
@Injectable()
export class LeadAiRegistrations implements OnModuleInit {
  constructor(private readonly registry: AiTaskRegistry) {}

  onModuleInit(): void {
    // RF-03（2026-09-09 fixbatch 复验层8实锤）：英文过程草稿曾照落 done（已知挂账路径）。
    // 草稿是要发给客户的文本，行为红线与营销/chat 同款：R1 英文泄漏 + R3 广告法极限词
    // 全量送检（message/notes 两字段），hard → failed（路由已接 autoRetry，知因再答）。
    const postLintLeadDraftOutput = (output: unknown): LintResult => {
      if (!output || typeof output !== 'object') return { pass: true, issues: [] };
      const { message, notes } = output as { message?: unknown; notes?: unknown };
      const fields: Record<string, string> = {};
      if (typeof message === 'string' && message.trim()) fields.message = message;
      if (typeof notes === 'string' && notes.trim()) fields.notes = notes;
      return lintAgentOutput(fields);
    };
    this.registry.register({
      taskType: 'lead.summary',
      skillName: 'skill-lead-summary',
      outputSchema: LeadSummaryOutputSchema,
      normalize: normalizeLeadSummary,
      deadlineSeconds: 120,
      constraints: {
        boundary:
          '仅依据给定客资上下文摘要，不臆造身份，不报价，输出为建议态。主语归属必须准确：跟进记录中「老板/销售」的动作（发报价单、给优惠、承诺同行结算价、展示案例）与「客户」的动作（询问、砍价、确认提车）不得混淆——把门店动作写成客户动作是严重错误。直接输出严格 JSON，不要任何过程性叙述或英文独白。',
      },
    });
    this.registry.register({
      taskType: 'sales.draft_message',
      skillName: 'skill-sales-draft',
      outputSchema: LeadDraftOutputSchema,
      normalize: normalizeLeadDraft,
      deadlineSeconds: 120,
      constraints: DRAFT_CONSTRAINTS,
      postLint: postLintLeadDraftOutput,
    });
    this.registry.register({
      taskType: 'lead.classify',
      skillName: 'skill-lead-classify',
      outputSchema: LeadClassifyOutputSchema,
      normalize: normalizeLeadClassify,
      deadlineSeconds: 120,
      constraints: CLASSIFY_CONSTRAINTS,
    });
  }
}

/** 客资 AI 子模块（P3-05）：注册 lead.summary + 分配触发 + 摘要展示/反馈端点服务。
 * 依赖 AiDispatchModule（submitTask/registry/taskRepo/customerRef 均经其导出）。 */
@Module({
  imports: [AiDispatchModule],
  providers: [LeadAiRegistrations, LeadSummaryTrigger, LeadClassifyTrigger],
  exports: [LeadSummaryTrigger, LeadClassifyTrigger],
})
export class LeadAiModule {}
