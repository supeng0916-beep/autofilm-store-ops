/** 知识条目状态：草稿/生效/过期（P4-01） */
export const KNOWLEDGE_STATUS = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  EXPIRED: 'expired',
} as const;

export type KnowledgeStatus = (typeof KNOWLEDGE_STATUS)[keyof typeof KNOWLEDGE_STATUS];

export const KNOWLEDGE_STATUS_VALUES = Object.values(KNOWLEDGE_STATUS) as [
  KnowledgeStatus,
  ...KnowledgeStatus[],
];

/** 合法状态迁移表：draft→active|expired, active→expired, expired 为终态 */
export const KNOWLEDGE_STATUS_TRANSITIONS: Record<KnowledgeStatus, KnowledgeStatus[]> = {
  draft: [KNOWLEDGE_STATUS.ACTIVE, KNOWLEDGE_STATUS.EXPIRED],
  active: [KNOWLEDGE_STATUS.EXPIRED],
  expired: [],
};

/** 校验状态迁移是否合法 */
export function canTransitionStatus(from: KnowledgeStatus, to: KnowledgeStatus): boolean {
  return KNOWLEDGE_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}
