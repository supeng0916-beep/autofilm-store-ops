import { http } from './http';

export interface ImportPreview {
  previewToken: string;
  rowCount: number;
  okCount: number;
  errorRows: Array<{ row: number; message: string }>;
  warnings: string[];
}

export interface ImportResult {
  batchId: string;
  created: number;
  dupCount: number;
  warnings: string[];
}

/** SLA 派生状态（对齐后端 sla.service 的 LeadSla） */
export type SlaState = 'ok' | 'remind' | 'breach' | 'escalate' | 'done' | 'na';

export interface LeadSla {
  state: SlaState;
  dueInMinutes: number | null;
}

/** 客资队列行（GET /leads 返回体子集，字段口径见客资表字段字典） */
export interface Lead {
  id: string;
  leadNo: string;
  customerName: string | null;
  sourcePlatform: string;
  intentLevel: string;
  stage: string;
  finalStatus: string;
  ownerUserId: string | null;
  contentId?: string | null;
  gender?: string | null;
  ageBand?: string | null;
  industry?: string | null;
  district?: string | null;
  purchaseDealer?: string | null;
  /** 负责人显示名（2026-08-28 bug1：列表/详情直接显示，不再渲染 cuid 内部 ID） */
  ownerName?: string | null;
  nextStep: string | null;
  receivedAt: string;
  firstContactAttemptAt: string | null;
  /** 仅列表 list() 返回 sla 派生字段；详情 getDetail() 亦返回（Task 11 详情页 SLA 卡） */
  sla?: LeadSla;
}

/** 客资详情（GET /leads/:id，P3-06）：完整客资字段＋sla 派生（chatLink 由后端按角色脱敏） */
export interface LeadDetail extends Lead {
  sourceCategory: string;
  businessType: string;
  target: string | null;
  productNeed: string | null;
  rawNeed: string | null;
  chatLink: string | null;
  phone: string | null;
  wechat: string | null;
  receivedAt: string;
  dueAt: string | null;
  assignedAt: string | null;
  nextFollowUpAt: string | null;
  firstCustomerReplyAt: string | null;
  lastFollowUpResult: string | null;
  /** 客户档案 ID（预约关联用；新客资在首次关联时由后端自动建档） */
  customerId?: string | null;
}

/** 客资时间线事件（GET /leads/:id/events） */
export interface LeadEventItem {
  id: string;
  kind: string;
  content: Record<string, unknown> | null;
  operatorId: string | null;
  occurredAt: string;
}

/** AI 客户摘要（GET /leads/:id/ai-summary，P3-05 建议态） */
export interface AiSummary {
  taskId: string;
  summary: string;
  concerns: string[];
  questionsToAsk: string[];
  nextAction: string;
  visitPitch?: string;
  escalationHint?: string;
  createdAt: string;
  feedback?: { decision: string; note: string | null; createdAt: string } | null;
}

/** AI 建议进度（2026-08-26 O8 评测缺口）：none=从未生成；pending=在途（详情页轮询依据）；
 * done/degraded/cancelled=已定。与后端 LeadAiProgress 对齐。 */
export type LeadAiProgress = 'none' | 'pending' | 'done' | 'degraded' | 'cancelled';

/** 摘要状态视图（GET /leads/:id/ai-summary 响应）：最新一次失败时 summary 仍回旧建议 */
export interface AiSummaryStatus {
  status: LeadAiProgress;
  summary: AiSummary | null;
}

/** 历史草稿项（GET /leads/:id/drafts，AI 原建议＋人工改写合并） */
export interface DraftItem {
  taskId: string;
  version: number;
  text: string;
  source: 'ai' | 'human_edit';
  notes: string | null;
  createdAt: string;
}

/** 草稿生成返回体（POST /leads/:id/drafts，建议态） */
export interface DraftView {
  taskId: string;
  status: string;
  message: string | null;
  notes: string | null;
  createdAt: string;
}

/** 意向分级建议（GET /leads/:id/intent-proposals，P3-07 建议态） */
export interface IntentProposal {
  taskId: string;
  level: 'high' | 'mid' | 'low' | 'pending';
  confidence: number;
  evidence: string[];
  missingInfo: string[];
  nextAction?: string;
  createdAt: string;
}

/** 意向建议状态视图（GET /leads/:id/intent-proposals 响应，2026-08-26 O8 评测缺口） */
export interface IntentProposalStatus {
  status: LeadAiProgress;
  proposal: IntentProposal | null;
}

export interface LeadListParams {
  stage?: string;
  finalStatus?: string;
  owner?: string;
  keyword?: string;
}

/** 手工登记载荷（POST /leads，2026-08-25 老板需求）：字段=客资字段字典 17 列导入子集（英文枚举）；
 * 电话/微信至少一项由后端 Zod refine 强制；ownerUserId 可选指定，缺省走分派池自动路由 */
export interface ManualLeadPayload {
  sourceCategory: 'online' | 'offline';
  sourcePlatform: string;
  operatorEntity?: string;
  acquisitionMethod?: string;
  upstreamDispatchNo?: string;
  adPlanText?: string;
  contentId?: string;
  chatLink?: string;
  customerName?: string;
  phone?: string;
  wechat?: string;
  wechatType?: 'real' | 'virtual_ewm' | 'unknown';
  businessType?: 'auto_film' | 'home_film';
  target?: string;
  productNeed: string;
  rawNeed?: string;
  remark?: string;
  ownerUserId?: string;
}

/** 实时查重结果（GET /leads/dup-check）：命中返回主客资概要（不含联系方式明文） */
export interface DupCheckResult {
  duplicate: boolean;
  lead?: {
    id: string;
    leadNo: string;
    customerName: string | null;
    stage: string;
    receivedAt: string;
  };
}

/** 可指定负责人（GET /leads/assignable-users）：在职 boss/店长/销售 */
export interface AssignableUser {
  id: string;
  username: string;
  displayName: string;
}

export const leadsApi = {
  previewImport: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return http.post<ImportPreview>('/leads/import/preview', form).then((r) => r.data);
  },
  confirmImport: (previewToken: string) =>
    http.post<ImportResult>('/leads/import/confirm', { previewToken }).then((r) => r.data),
  importDispatch: (rawTexts: string[]) =>
    http.post<ImportResult>('/leads/import/dispatch', { rawTexts }).then((r) => r.data),
  importKingsoft: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return http.post<ImportResult>('/leads/import/kingsoft', form).then((r) => r.data);
  },
  /** 鉴权下载（blob）：文件端点必须带 token，裸 <a href>/window.open 会 401（踩坑实录同口径） */
  downloadTemplate: () =>
    http.get<Blob>('/leads/import/template.xlsx', { responseType: 'blob' }).then((r) => r.data),
  downloadErrorExport: (token: string) =>
    http
      .get<Blob>(`/leads/import/error-export/${token}`, { responseType: 'blob' })
      .then((r) => r.data),
  list: (params: LeadListParams = {}) => http.get<Lead[]>('/leads', { params }).then((r) => r.data),
  /** 手工登记（POST /leads，2026-08-25）：返回新建客资（含 leadNo） */
  register: (body: ManualLeadPayload) => http.post<Lead>('/leads', body).then((r) => r.data),
  /** 实时查重（GET /leads/dup-check）：登记表单电话/微信输入时调用 */
  dupCheck: (params: { phone?: string; wechat?: string }) =>
    http.get<DupCheckResult>('/leads/dup-check', { params }).then((r) => r.data),
  /** 可指定负责人清单（登记表单下拉） */
  assignableUsers: () => http.get<AssignableUser[]>('/leads/assignable-users').then((r) => r.data),
  get: (id: string) => http.get<Lead>(`/leads/${id}`).then((r) => r.data),
  /** 详情：完整客资字段＋sla（P3-06） */
  getDetail: (id: string) => http.get<LeadDetail>(`/leads/${id}`).then((r) => r.data),
  events: (id: string) => http.get<LeadEventItem[]>(`/leads/${id}/events`).then((r) => r.data),
  aiSummary: (id: string) =>
    http.get<AiSummaryStatus>(`/leads/${id}/ai-summary`).then((r) => r.data),
  /** 手动重提摘要（POST /leads/:id/ai-summary/regenerate，2026-08-26 O8 缺口）：非终态幂等 */
  summaryRegenerate: (id: string) =>
    http
      .post<{ taskId: string; status: string }>(`/leads/${id}/ai-summary/regenerate`)
      .then((r) => r.data),
  summaryFeedback: (id: string, body: { decision: string; note?: string }) =>
    http.post(`/leads/${id}/ai-summary/feedback`, body).then((r) => r.data),
  createDraft: (id: string, body: { goal?: string }) =>
    http.post<DraftView>(`/leads/${id}/drafts`, body).then((r) => r.data),
  patchDraft: (id: string, taskId: string, text: string) =>
    http.patch(`/leads/${id}/drafts/${taskId}`, { text }).then((r) => r.data),
  copyDraft: (id: string, taskId: string) =>
    http.post(`/leads/${id}/drafts/${taskId}/copy`).then((r) => r.data),
  sendRecord: (id: string, taskId: string, sendEvidence: string) =>
    http.post(`/leads/${id}/drafts/${taskId}/send-record`, { sendEvidence }).then((r) => r.data),
  listDrafts: (id: string) => http.get<DraftItem[]>(`/leads/${id}/drafts`).then((r) => r.data),
  /** 阶段推进（Task 9 PATCH /leads/:id/stage） */
  transitionStage: (id: string, body: { stage: string; reason: string }) =>
    http.patch(`/leads/${id}/stage`, body).then((r) => r.data),
  /** 人工接管（POST /leads/:id/takeover，仅老板/店长）：改派自己＋机会标记＋三要素留痕 */
  takeover: (id: string, body: { reason: string; evidence: string; nextAction: string }) =>
    http.post<Lead>(`/leads/${id}/takeover`, body).then((r) => r.data),
  /** 无主客资认领（POST /leads/:id/claim，到店客资等接待人手工认领） */
  claim: (id: string) =>
    http.post<{ ownerUserId: string }>(`/leads/${id}/claim`).then((r) => r.data),
  /** 建议流失（Task 9 POST /leads/:id/churn-propose） */
  proposeChurn: (id: string, body: { reason: string; note?: string }) =>
    http.post(`/leads/${id}/churn-propose`, body).then((r) => r.data),
  /** 跟进记录（Task 9 POST /leads/:id/follow-up） */
  recordFollowUp: (
    id: string,
    body: { result: string; nextAction: string; nextFollowUpAt: string; waitCustomer?: boolean },
  ) => http.post(`/leads/${id}/follow-up`, body).then((r) => r.data),
  contactAttempt: (id: string) =>
    http
      .post<{ id: string; firstContactAttemptAt: string }>(`/leads/${id}/contact-attempt`)
      .then((r) => r.data),
  customerReply: (id: string) =>
    http
      .post<{ id: string; firstCustomerReplyAt: string }>(`/leads/${id}/customer-reply`)
      .then((r) => r.data),
  /** 意向分级建议（P3-07 建议态；2026-08-26 起状态视图） */
  intentProposals: (id: string) =>
    http.get<IntentProposalStatus>(`/leads/${id}/intent-proposals`).then((r) => r.data),
  /** 手动触发生成分级建议（POST /leads/:id/classify）：空态/失败后一键生成 */
  classifySubmit: (id: string) =>
    http.post<{ taskId: string; status: string }>(`/leads/${id}/classify`).then((r) => r.data),
  /** 标记成交（POST /leads/:id/won，2026-08-28 bug3：前端此前无入口）：金额分+理由必填 */
  won: (id: string, body: { amountFen: number; reason: string }) =>
    http.post(`/leads/${id}/won`, body).then((r) => r.data),

  /** 意向分级人工确认/改判（P3-07） */
  intentConfirm: (id: string, body: { taskId: string; level?: string; reason?: string }) =>
    http.post(`/leads/${id}/intent-confirm`, body).then((r) => r.data),
};

/** 客资画像编辑（批次2 T8）：五字段可选至少一项 */
export const leadProfileApi = {
  updateProfile: (
    id: string,
    data: {
      gender?: 'male' | 'female';
      ageBand?: '18-25' | '26-35' | '36-45' | '46-55' | '55+';
      industry?: string;
      district?: string;
      purchaseDealer?: string;
    },
  ) => http.patch(`/leads/${id}/profile`, data).then((r) => r.data),
};
