import { http } from './http';

/** AI 通道状态（GET /ai/status，全体登录用户可见，供降级横幅，P2-09） */
export interface AiStatus {
  globalEnabled: boolean;
  healthy: boolean;
  lastHealthyAt: string | null;
  lastError: string | null;
  skills: { taskType: string; enabled: boolean }[];
  notice: string | null;
}

/** AI 开关快照（GET/PUT /ai/switches，仅 system:manage） */
export interface AiSwitchSnapshot {
  global: boolean;
  skills: { taskType: string; enabled: boolean }[];
}

/** AI 成本日报条目（GET /ai/costs/daily，仅 ai:cost:view：boss/sys_admin） */
export interface AiDailyCost {
  date: string;
  taskCount: number;
  tokensIn: number;
  tokensOut: number;
  /** 成本（分）；前端按元展示：costFen/100 toFixed(2) */
  costFen: number;
}

/** AI 当日预算状态（GET /ai/costs/status，仅 ai:cost:view）：已耗/有效预算/梯度告警线，单位分 */
export interface AiBudgetStatus {
  date: string;
  spentFen: number;
  budgetFen: number;
  warnFen: number;
  alertFen: number;
}

/** AI 成本分解行（GET /ai/costs/breakdown，仅 ai:cost:view）：日期×模型×任务类型聚合 */
export interface AiCostBreakdownRow {
  date: string;
  model: string;
  taskType: string;
  taskCount: number;
  tokensIn: number;
  tokensOut: number;
  /** 成本（分）；前端按元展示：costFen/100 toFixed(2) */
  costFen: number;
}

/** 开关切换入参；scope 用联合类型（前端禁用 enum） */
export interface SetAiSwitchInput {
  scope: 'global' | 'skill';
  /** scope='skill' 时必填 */
  taskType?: string;
  enabled: boolean;
}

export function fetchAiStatus(): Promise<AiStatus> {
  return http.get<AiStatus>('/ai/status').then((r) => r.data);
}

export function fetchAiSwitches(): Promise<AiSwitchSnapshot> {
  return http.get<AiSwitchSnapshot>('/ai/switches').then((r) => r.data);
}

/** 切换开关：前端统一补 confirmed:true（与后端 literal(true) 校验双保险，同审批模式） */
export function setAiSwitch(input: SetAiSwitchInput): Promise<AiSwitchSnapshot> {
  return http
    .put<AiSwitchSnapshot>('/ai/switches', { ...input, confirmed: true })
    .then((r) => r.data);
}

export function fetchAiDailyCosts(days = 7): Promise<AiDailyCost[]> {
  return http.get<AiDailyCost[]>('/ai/costs/daily', { params: { days } }).then((r) => r.data);
}

export function fetchAiBudgetStatus(): Promise<AiBudgetStatus> {
  return http.get<AiBudgetStatus>('/ai/costs/status').then((r) => r.data);
}

/** 使用画像（V1.5 批次3）：人+AI 协作三维聚合 */
export interface AiUsageUserRow {
  userId: string;
  username: string;
  displayName: string;
  taskCount: number;
  doneCount: number;
  failCount: number;
  costFen: number;
  feedbackTotal: number;
  feedbackAdopted: number;
}

export interface AiUsageTaskTypeRow {
  taskType: string;
  count: number;
  doneCount: number;
  costFen: number;
}

export interface AiUsageSummary {
  days: number;
  byUser: AiUsageUserRow[];
  byTaskType: AiUsageTaskTypeRow[];
  byDay: Array<{ date: string; count: number; costFen: number }>;
  total: { taskCount: number; costFen: number };
}

export function fetchAiUsageSummary(days = 30): Promise<AiUsageSummary> {
  return http.get<AiUsageSummary>('/ai/usage/summary', { params: { days } }).then((r) => r.data);
}

/** 影子模式·话术对比（事件源，AI 草稿 vs 人工实发）：samples 80 字截断仅展示用，
 * 转卡时服务端按 taskId 重查全文；verbatimCandidates＝照发候选（相似度≥0.999） */
export interface ShadowDraftSummary {
  days: number;
  total: number;
  avgSimilarity: number;
  verbatimRate: number;
  samples: Array<{
    taskId: string;
    leadId: string;
    similarity: number;
    original: string;
    actual: string;
  }>;
  verbatimCandidates: Array<{ taskId: string; leadId: string; original: string }>;
}

export function fetchShadowDraft(days = 30): Promise<ShadowDraftSummary> {
  return http.get<ShadowDraftSummary>('/ai/shadow/draft', { params: { days } }).then((r) => r.data);
}

/** 影子模式·意向对比（批次5）：AI 判级 vs 人工终判 */
export interface ShadowIntentSummary {
  days: number;
  total: number;
  agreed: number;
  agreementRate: number;
  overrides: Array<{ aiLevel: string; humanLevel: string; count: number }>;
  overrideSamples: Array<{
    leadId: string;
    leadNo: string;
    aiLevel: string;
    humanLevel: string;
    reason: string | null;
  }>;
}

export function fetchShadowIntent(days = 30): Promise<ShadowIntentSummary> {
  return http
    .get<ShadowIntentSummary>('/ai/shadow/intent', { params: { days } })
    .then((r) => r.data);
}

/** 影子样本转经验卡结果（POST /ai/shadow/experience）：createFromChat 落的建议态条目。
 * approvalId（P3-F03 修复）：转卡即创建的 knowledge.activate 审批单——老板批准后自动生效，
 * 「待老板审批」提示由此在审批中心可兑现 */
export interface ShadowHarvestResult {
  id: string;
  kind: string;
  status: string;
  title: string;
  source: string | null;
  approvalId: string;
}

/** 影子样本一键转经验卡（阶段三 B2）：draft 按 taskId；intent 按 leadId+双判级。
 * 确定性拼卡零 AI 成本，落 draft 态待老板审批生效。 */
export function harvestShadowExperience(input: {
  scope: 'draft';
  taskId: string;
}): Promise<ShadowHarvestResult>;
export function harvestShadowExperience(input: {
  scope: 'intent';
  leadId: string;
  aiLevel: string;
  humanLevel: string;
  reason?: string;
}): Promise<ShadowHarvestResult>;
export function harvestShadowExperience(input: {
  scope: 'draft' | 'intent';
  taskId?: string;
  leadId?: string;
  aiLevel?: string;
  humanLevel?: string;
  reason?: string;
}): Promise<ShadowHarvestResult> {
  return http.post<ShadowHarvestResult>('/ai/shadow/experience', input).then((r) => r.data);
}

/** 技能版本视图与一键回滚（批次5，boss∪sys_admin） */
export interface SkillVersionRow {
  taskType: string;
  skillName: string;
  current: number | null;
  versions: number[];
}

export function fetchSkillVersions(): Promise<SkillVersionRow[]> {
  return http.get<SkillVersionRow[]>('/ai/skills/versions').then((r) => r.data);
}

export function rollbackSkill(skillName: string, version: number): Promise<{ ok: boolean }> {
  return http
    .post('/ai/skills/rollback', { skillName, version }, { timeout: 30_000 })
    .then((r) => r.data);
}

export function fetchAiCostBreakdown(days = 7): Promise<AiCostBreakdownRow[]> {
  return http
    .get<AiCostBreakdownRow[]>('/ai/costs/breakdown', { params: { days } })
    .then((r) => r.data);
}

/** 老板临时提额（POST /ai/costs/daily-budget，仅当日有效、次日自动回落）；后端 boss 硬校验兜底 */
export function setAiDailyBudget(budgetFen: number): Promise<void> {
  return http.post<void>('/ai/costs/daily-budget', { budgetFen }).then((r) => r.data);
}
