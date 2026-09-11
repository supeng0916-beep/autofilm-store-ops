import { http } from './http';

/** AI 任务状态联合（后端 ai-dispatch.states 唯一事实源的镜像；前端禁用 enum） */
export type AiTaskStatus =
  | 'pending'
  | 'dispatched'
  | 'running'
  | 'callback_received'
  | 'validated'
  | 'done'
  | 'failed'
  | 'timeout'
  | 'degraded'
  | 'cancelled';

/** AI 任务（GET /ai/tasks，Prisma 全字段直出；Date 序列化为 ISO 串） */
export interface AiTask {
  id: string;
  taskType: string;
  refType: string | null;
  refId: string | null;
  status: AiTaskStatus;
  inputSummary: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  /** 回调落定的结构化输出（形态随 taskType 而异），未落定为 null */
  output: unknown;
  retryCount: number;
  deadlineAt: string | null;
  dispatchedAt: string | null;
  callbackAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  /** 成本（分）；前端按元展示 */
  costEstimateFen: number | null;
  createdAt: string;
  updatedAt: string;
}

/** AI 任务状态事件（只增不改的状态线，与后端 AiTaskEvent 同构） */
export interface AiTaskEvent {
  id: string;
  taskId: string;
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  createdAt: string;
}

/** GET /ai/tasks/:id 返回：任务 + 事件（createdAt asc） */
export interface AiTaskDetail {
  task: AiTask;
  events: AiTaskEvent[];
}

/** 列表筛选入参（均可选） */
export interface AiTaskListParams {
  status?: AiTaskStatus;
  taskType?: string;
}

/** 任务列表（V2.2b 控制台只读，最近 50 条） */
export function fetchAiTasks(params: AiTaskListParams = {}): Promise<AiTask[]> {
  return http.get<AiTask[]>('/ai/tasks', { params }).then((r) => r.data);
}

/** 任务详情（含事件时间线） */
export function fetchAiTaskDetail(id: string): Promise<AiTaskDetail> {
  return http.get<AiTaskDetail>(`/ai/tasks/${id}`).then((r) => r.data);
}

/** 重试：以新任务重放（仅 failed/degraded，其余 409；原任务不变） */
export function retryAiTask(id: string): Promise<AiTask> {
  return http.post<AiTask>(`/ai/tasks/${id}/retry`).then((r) => r.data);
}

/** 人工接管：写 manual_takeover 事件留痕，幂等 */
export function takeoverAiTask(id: string): Promise<{ id: string; tookOver: boolean }> {
  return http
    .post<{ id: string; tookOver: boolean }>(`/ai/tasks/${id}/takeover`)
    .then((r) => r.data);
}
