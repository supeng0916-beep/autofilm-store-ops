import { http } from './http';

/** 陪练回合（批次6a）：role=staff（员工）/customer（AI 演客户） */
export interface RoleplayTurn {
  role: 'staff' | 'customer';
  content: string;
}

/** AI 客户情绪趋势（供界面展示，复盘参考） */
export type RoleplayMood = 'interested' | 'neutral' | 'annoyed' | 'close_deal_hint';

/** 陪练点评（批次6a review 模式）：教练复盘结构 */
export interface RoleplayReview {
  summary: string;
  strengths?: string[];
  improvements?: string[];
  demo?: string;
}

/** 剧本目录（与后端 ROLEPLAY_SCENARIOS 同步） */
export const SCENARIOS = [
  { value: 'first_touch', label: '首次触达' },
  { value: 'price_objection', label: '报价异议' },
  { value: 'compare', label: '同行比价' },
  { value: 'bargain', label: '砍价拉锯' },
  { value: 'silent_revive', label: '沉默唤醒' },
] as const;

/** 客户画像难度 */
export const DIFFICULTIES = [
  { value: 'easy', label: '温和客户' },
  { value: 'normal', label: '普通客户' },
  { value: 'hard', label: '刁钻客户' },
] as const;

export const roleplayApi = {
  /** 开局：选剧本+画像，返回会话 id 与客户开场白 */
  start: (scenario: string, persona: Record<string, unknown>) =>
    http
      .post<{ sessionId: string; turns: RoleplayTurn[] }>(
        '/agent/roleplay/sessions',
        { scenario, persona },
        { timeout: 90_000 },
      )
      .then((r) => r.data),

  /** 回合：员工发言 → AI 客户回应 */
  turn: (sessionId: string, message: string) =>
    http
      .post<{ reply: string; mood?: RoleplayMood; turns: RoleplayTurn[] }>(
        `/agent/roleplay/sessions/${sessionId}/turns`,
        { message },
        { timeout: 90_000 },
      )
      .then((r) => r.data),

  /** 结束点评（自评 1~5 可空；幂等） */
  finish: (sessionId: string, score?: number) =>
    http
      .post<RoleplayReview>(
        `/agent/roleplay/sessions/${sessionId}/finish`,
        { ...(score ? { score } : {}) },
        { timeout: 120_000 },
      )
      .then((r) => r.data),

  /** 经验卡提炼（批次6b 学习闭环）：陪练会话或粘贴聊天记录 → 建议态经验卡（待老板审批） */
  extract: (input: { sessionId?: string; rawText?: string }) =>
    http
      .post<{
        rejected: boolean;
        reason?: string;
        item?: { id: string; kind: string; status: string; title: string };
      }>('/agent/roleplay/experience/extract', input, { timeout: 90_000 })
      .then((r) => r.data),

  /** 自己的会话列表 */
  list: () =>
    http
      .get<
        Array<{
          id: string;
          scenario: string;
          status: string;
          score: number | null;
          startedAt: string;
          turnCount: number;
        }>
      >('/agent/roleplay/sessions')
      .then((r) => r.data),
};
