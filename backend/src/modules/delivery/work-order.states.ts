/** 施工单阶段状态机（P5-04，S11 确定性代码）：技师不设账号，信息由记录员代录、店长复检确认 */
export const WO_STAGE = {
  PENDING: 'pending', // 待入场
  IN_PROGRESS: 'in_progress', // 施工中
  SELF_CHECK_DONE: 'self_check_done', // 技师自检完成（记录员代录真人确认）
  RECHECK_DONE: 'recheck_done', // 店长复检完成
  DELIVERED: 'delivered', // 已交付（终态）
} as const;
export type WorkOrderStage = (typeof WO_STAGE)[keyof typeof WO_STAGE];

export const WO_STAGE_VALUES = Object.values(WO_STAGE) as [WorkOrderStage, ...WorkOrderStage[]];

/** 合法迁移表：顺序推进；self_check_done/recheck_done 可返 in_progress（＝返工，P5-05） */
export const WO_STAGE_TRANSITIONS: Record<WorkOrderStage, readonly WorkOrderStage[]> = {
  [WO_STAGE.PENDING]: [WO_STAGE.IN_PROGRESS],
  [WO_STAGE.IN_PROGRESS]: [WO_STAGE.SELF_CHECK_DONE],
  [WO_STAGE.SELF_CHECK_DONE]: [WO_STAGE.RECHECK_DONE, WO_STAGE.IN_PROGRESS],
  [WO_STAGE.RECHECK_DONE]: [WO_STAGE.DELIVERED, WO_STAGE.IN_PROGRESS],
  [WO_STAGE.DELIVERED]: [],
};

export function canTransitionWoStage(from: WorkOrderStage, to: WorkOrderStage): boolean {
  return WO_STAGE_TRANSITIONS[from]?.includes(to) ?? false;
}

export const WO_STAGE_LABEL: Record<WorkOrderStage, string> = {
  pending: '待入场',
  in_progress: '施工中',
  self_check_done: '自检完成',
  recheck_done: '复检完成',
  delivered: '已交付',
};
