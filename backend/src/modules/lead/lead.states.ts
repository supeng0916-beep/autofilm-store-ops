/** 客资三轴状态（D-P3-3）：stage=销售作业进度，finalStatus=最终状态，silenceStage=沉默子状态 */
export const LEAD_STAGE = {
  NEW: 'new', // 新线索（待首次触达）
  CONTACTED: 'contacted', // 已首次触达
  COMMUNICATING: 'communicating', // 沟通中（微信或原平台沟通）
  QUOTED: 'quoted', // 已报价
  VISIT_BOOKED: 'visit_booked', // 已预约到店/勘察
  VISIT_DONE: 'visit_done', // 已到店/勘察完成
} as const;
export type LeadStage = (typeof LEAD_STAGE)[keyof typeof LEAD_STAGE];

export const LEAD_FINAL_STATUS = {
  ACTIVE: 'active',
  SILENCE: 'silence',
  LOST_PENDING: 'lost_pending',
  LOST: 'lost',
  WON: 'won',
  INVALID: 'invalid',
} as const;
export type LeadFinalStatus = (typeof LEAD_FINAL_STATUS)[keyof typeof LEAD_FINAL_STATUS];

export const LEAD_SILENCE_STAGE = {
  NONE: 'none',
  RISK: 'risk',
  FOLLOW_DUE: 'follow_due',
  NURTURE: 'nurture',
} as const;

export const LEAD_INTENT = { HIGH: 'high', MID: 'mid', LOW: 'low', PENDING: 'pending' } as const;

/** 阶段合法迁移表（顺序推进＋报价后可回沟通；表外一律 LEAD_INVALID_STATE） */
export const LEAD_STAGE_TRANSITIONS: Record<LeadStage, readonly LeadStage[]> = {
  [LEAD_STAGE.NEW]: [LEAD_STAGE.CONTACTED],
  [LEAD_STAGE.CONTACTED]: [LEAD_STAGE.COMMUNICATING],
  [LEAD_STAGE.COMMUNICATING]: [LEAD_STAGE.QUOTED, LEAD_STAGE.VISIT_BOOKED],
  [LEAD_STAGE.QUOTED]: [LEAD_STAGE.COMMUNICATING, LEAD_STAGE.VISIT_BOOKED],
  [LEAD_STAGE.VISIT_BOOKED]: [LEAD_STAGE.VISIT_DONE, LEAD_STAGE.COMMUNICATING],
  [LEAD_STAGE.VISIT_DONE]: [LEAD_STAGE.QUOTED], // 到店后二次报价（升单不做默认强推）
};
export function canTransitionStage(from: LeadStage, to: LeadStage): boolean {
  return LEAD_STAGE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** 全局角色（boss/store_manager）判定：全局视野（D-P3-10 数据范围）。
 * 与 isWalkInLead 同属 lead 域纯谓词，放纯函数模块避免 assign↔service 循环依赖。 */
export function isGlobalRole(roles: readonly string[]): boolean {
  return roles.includes('boss') || roles.includes('store_manager');
}
