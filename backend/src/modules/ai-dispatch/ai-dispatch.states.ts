/** AI 任务状态机（规格 §5.1）。确定性实现：流转表是代码常量，模型输出无权改状态。
 * timeout 为保留态（D-P2-1）：V1 超时扫描直接 dispatched → degraded(reason='timeout')。 */
export const AI_TASK_STATUS = {
  PENDING: 'pending',
  DISPATCHED: 'dispatched',
  RUNNING: 'running',
  CALLBACK_RECEIVED: 'callback_received',
  VALIDATED: 'validated',
  DONE: 'done',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  DEGRADED: 'degraded',
  CANCELLED: 'cancelled',
} as const;
export type AiTaskStatus = (typeof AI_TASK_STATUS)[keyof typeof AI_TASK_STATUS];

/** 终态：不可再迁移（重复回调幂等判定也依据此集合，D-P2-8） */
export const AI_TASK_TERMINAL: readonly AiTaskStatus[] = [
  AI_TASK_STATUS.DONE,
  AI_TASK_STATUS.DEGRADED,
  AI_TASK_STATUS.CANCELLED,
];

/** 合法迁移表；表外一律 AI_TASK_INVALID_STATE */
export const AI_TASK_TRANSITIONS: Record<AiTaskStatus, readonly AiTaskStatus[]> = {
  [AI_TASK_STATUS.PENDING]: ['dispatched', 'cancelled', 'degraded'],
  [AI_TASK_STATUS.DISPATCHED]: ['running', 'callback_received', 'failed', 'degraded'],
  [AI_TASK_STATUS.RUNNING]: ['callback_received', 'failed', 'degraded'],
  [AI_TASK_STATUS.CALLBACK_RECEIVED]: ['validated', 'degraded', 'failed'],
  [AI_TASK_STATUS.VALIDATED]: ['done'],
  [AI_TASK_STATUS.FAILED]: ['degraded'],
  [AI_TASK_STATUS.DONE]: [],
  [AI_TASK_STATUS.TIMEOUT]: [],
  [AI_TASK_STATUS.DEGRADED]: [],
  [AI_TASK_STATUS.CANCELLED]: [],
};

export function canTransition(from: AiTaskStatus, to: AiTaskStatus): boolean {
  return AI_TASK_TRANSITIONS[from]?.includes(to) ?? false;
}
