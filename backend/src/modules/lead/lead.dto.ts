import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AGE_BAND_VALUES, GENDER_VALUES } from './lead.constants';

import {
  CHURN_REASON,
  type ChurnReason,
  LEAD_BUSINESS_TYPES,
  WECHAT_TYPES,
} from './lead.constants';
import { LEAD_INTENT, LEAD_STAGE, type LeadStage } from './lead.states';

/** 队列查询（GET /leads）：stage/finalStatus/owner/keyword 可选过滤；
 * 数据范围（scope）由服务端按角色强制，不受 query.owner 影响（sales_ops 恒本人）。 */
export class ListLeadsQueryDto extends createZodDto(
  z.object({
    stage: z.string().min(1).max(32).optional(),
    finalStatus: z.string().min(1).max(32).optional(),
    owner: z.string().min(1).optional(),
    keyword: z.string().min(1).max(100).optional(),
  }),
) {}

/** 手动改派（PATCH /leads/:id/assign）：目标负责人与改派理由均必填（D-P3-6 分配口径） */
export class AssignLeadDto extends createZodDto(
  z.object({
    ownerUserId: z.string().min(1, '缺少目标负责人'),
    reason: z.string().min(1, '改派必须填写理由').max(500),
  }),
) {}

const LEAD_STAGE_VALUES = Object.values(LEAD_STAGE) as [LeadStage, ...LeadStage[]];
const CHURN_REASON_VALUES = Object.values(CHURN_REASON) as [ChurnReason, ...ChurnReason[]];

/** 阶段推进（PATCH /leads/:id/stage）：目标阶段枚举＋理由必填（≥2 字，P3-04） */
export class TransitionStageDto extends createZodDto(
  z.object({
    stage: z.enum(LEAD_STAGE_VALUES),
    reason: z.string().min(2, '阶段推进必须填写理由（≥2字）').max(500),
  }),
) {}

/** 建议流失（POST /leads/:id/churn-propose）：reason 枚举必选；选「其他」须附说明（P3-04） */
export class ProposeChurnDto extends createZodDto(
  z
    .object({
      reason: z.enum(CHURN_REASON_VALUES),
      note: z.string().min(2, '流失说明至少2字').max(500).optional(),
    })
    .superRefine((val, ctx) => {
      if (val.reason === CHURN_REASON.OTHER && !val.note) {
        ctx.addIssue({
          code: 'custom',
          path: ['note'],
          message: '选择「其他」必须填写流失说明',
        });
      }
    }),
) {}

/** 重开（POST /leads/:id/reopen）：理由必填（仅 boss/store_manager，服务层校验） */
export class ReopenLeadDto extends createZodDto(
  z.object({ reason: z.string().min(2, '重开必须填写理由（≥2字）').max(500) }),
) {}

/** 成交（POST /leads/:id/won）：金额（分）与原因必填；Opportunity 扩展字段可后补（P3-04） */
export class MarkWonDto extends createZodDto(
  z.object({
    amountFen: z.number().int().positive('成交金额（分）必填且为正'),
    reason: z.string().min(2, '成交原因必填（≥2字）').max(500),
    visitOriginalPlan: z.string().max(2000).optional(),
    visitFinalPlan: z.string().max(2000).optional(),
    upsellReason: z.string().max(2000).optional(),
    grossMarginImpact: z.string().max(2000).optional(),
  }),
) {}

/** 无效（POST /leads/:id/invalid）：原因必填 */
export class MarkInvalidDto extends createZodDto(
  z.object({ reason: z.string().min(2, '无效原因必填（≥2字）').max(500) }),
) {}

/** 跟进记录（POST /leads/:id/follow-up）：结果/下次动作/下次跟进时间必填（P3-04） */
export class RecordFollowUpDto extends createZodDto(
  z.object({
    result: z.string().min(1, '跟进结果必填').max(2000),
    nextAction: z.string().min(1, '下次动作必填').max(2000),
    nextFollowUpAt: z.coerce.date(),
    waitCustomer: z.boolean().optional(),
  }),
) {}

/** 暂停（POST /leads/:id/pause）：理由必填（仅 boss/store_manager，服务层校验） */
export class PauseLeadDto extends createZodDto(
  z.object({ reason: z.string().min(2, '暂停必须填写理由（≥2字）').max(500) }),
) {}

/** 接管（POST /leads/:id/takeover）：原因/证据/下次动作三要素必填（P3-04 简报要求） */
export class TakeoverLeadDto extends createZodDto(
  z.object({
    reason: z.string().min(2, '接管原因必填（≥2字）').max(500),
    evidence: z.string().min(2, '接管证据必填（≥2字）').max(2000),
    nextAction: z.string().min(2, '接管后下次动作必填（≥2字）').max(2000),
  }),
) {}

/** AI 摘要人工反馈决策（POST /leads/:id/ai-summary/feedback，P3-05） */
export const AI_SUMMARY_DECISIONS = ['adopted', 'modified', 'rejected'] as const;

/** AI 摘要反馈（P3-05）：decision 枚举必选；note 可选备注（M11 学习链数据源） */
export class AiSummaryFeedbackDto extends createZodDto(
  z.object({
    decision: z.enum(AI_SUMMARY_DECISIONS),
    note: z.string().max(1000).optional(),
  }),
) {}

/** 提交草稿任务（POST /leads/:id/drafts，P3-06）：goal 本轮目标可选（脱敏上下文附加） */
export class CreateDraftDto extends createZodDto(
  z.object({
    goal: z.string().max(500).optional(),
  }),
) {}

/** 销售改写草稿（PATCH /leads/:id/drafts/:taskId，P3-06）：改写文本必填非空（不改 ai_tasks.output） */
export class EditDraftDto extends createZodDto(
  z.object({
    text: z.string().min(1, '改写文本必填').max(2000),
  }),
) {}

/** 记录实际发送（POST /leads/:id/drafts/:taskId/send-record，P3-06）：
 * sendEvidence 必填且 ≥10 字符（聊天导入片段等实际发送证据，A10）。 */
export class SendRecordDto extends createZodDto(
  z.object({
    sendEvidence: z.string().min(10, '发送证据必填（≥10字，如聊天导入片段）').max(2000),
  }),
) {}

const LEAD_INTENT_VALUES = Object.values(LEAD_INTENT) as [
  (typeof LEAD_INTENT)[keyof typeof LEAD_INTENT],
  ...(typeof LEAD_INTENT)[keyof typeof LEAD_INTENT][],
];

/** 意向分级人工确认（POST /leads/:id/intent-confirm，P3-07）：taskId 必填；
 * level 可选＝人工改判等级（缺省沿用 AI 建议）；reason 为改判理由——
 * 2026-08-28 P2：改判（level 与 AI 建议不一致）时必填 ≥2 字（service 层强制，双口径留痕不缺理由），
 * 仅确认 AI 建议时不需；此处保持 optional 以承载两种形态。 */
export class IntentConfirmDto extends createZodDto(
  z.object({
    taskId: z.string().min(1, '缺少分级任务ID'),
    level: z.enum(LEAD_INTENT_VALUES).optional(),
    reason: z.string().min(2, '改判理由至少2字').max(500).optional(),
  }),
) {}

/** 手工登记客资（POST /leads，2026-08-25 老板需求）：字段=客资字段字典 17 列导入子集（英文枚举）；
 * 电话/微信至少一项（refine，同导入口径）；负责人可选指定，缺省走分派池自动路由。 */
export class ManualRegisterDto extends createZodDto(
  z
    .object({
      sourceCategory: z.enum(['online', 'offline']),
      sourcePlatform: z.string().min(1, '来源平台必填').max(100),
      operatorEntity: z.string().max(100).optional(),
      acquisitionMethod: z.string().max(100).optional(),
      upstreamDispatchNo: z.string().max(100).optional(),
      adPlanText: z.string().max(500).optional(),
      contentId: z.string().max(500).optional(),
      chatLink: z.string().max(1000).optional(),
      customerName: z.string().max(50).optional(),
      phone: z.string().trim().max(30).optional(),
      wechat: z.string().trim().max(100).optional(),
      wechatType: z.enum(WECHAT_TYPES).optional(),
      businessType: z.enum(LEAD_BUSINESS_TYPES).optional(),
      target: z.string().max(100).optional(),
      productNeed: z.string().min(1, '需求产品必填').max(200),
      rawNeed: z.string().max(2000).optional(),
      remark: z.string().max(500).optional(),
      ownerUserId: z.string().max(64).optional(),
    })
    .refine((r) => Boolean(r.phone || r.wechat), { message: '电话与微信至少填一项' }),
) {}

/** 实时查重（GET /leads/dup-check?phone=&wechat=）：登记表单电话/微信失焦时调用 */
export class DupCheckQueryDto extends createZodDto(
  z.object({
    phone: z.string().min(1).max(30).optional(),
    wechat: z.string().min(1).max(100).optional(),
  }),
) {}

/** 客资画像编辑（批次2 T4）：五字段全可选、至少一项；枚举项校验，画像不参与分配/SLA 仅记录统计 */
export class UpdateLeadProfileDto extends createZodDto(
  z
    .object({
      gender: z.enum(GENDER_VALUES).optional(),
      ageBand: z.enum(AGE_BAND_VALUES).optional(),
      industry: z.string().trim().max(50).optional(),
      district: z.string().trim().max(50).optional(),
      purchaseDealer: z.string().trim().max(100).optional(),
    })
    .refine((r) => Object.values(r).some((v) => v !== undefined), {
      message: '至少填写一项画像字段',
    }),
) {}
