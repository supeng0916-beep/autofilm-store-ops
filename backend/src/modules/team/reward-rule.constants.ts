/** 奖惩规则常量（批次3）：指标/比较符/方向枚举唯一来源——AI 不参与判定，系统只算账 */
export const REWARD_METRICS = ['delivered_count', 'rework_count', 'revenue_fen'] as const;
export type RewardMetric = (typeof REWARD_METRICS)[number];
export const REWARD_METRIC_LABEL: Record<RewardMetric, string> = {
  delivered_count: '交付工单数',
  rework_count: '返工次数',
  revenue_fen: '产值（分）',
};
export const REWARD_COMPARATORS = ['gte', 'lte'] as const;
export const REWARD_DIRECTIONS = ['reward', 'punish'] as const;
export const REWARD_DIRECTION_LABEL: Record<string, string> = { reward: '奖', punish: '惩' };
