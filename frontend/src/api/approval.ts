import { http } from './http';

/** 审批状态（与后端状态机一致，P1-05）：pending → approved | rejected | withdrawn。
 * 前端禁用 TS enum（全局约束），用 as const 对象 + 联合类型表达。 */
export const APPROVAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
} as const;
export type ApprovalStatus = (typeof APPROVAL_STATUS)[keyof typeof APPROVAL_STATUS];

export interface ApprovalItem {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  requesterId: string;
  /** 发起人姓名（2026-08-27 后端附带；旧数据缺省回退系统内部 ID） */
  requesterName?: string;
  status: ApprovalStatus;
  opinion: string | null;
  basis: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface CreateApprovalInput {
  type: string;
  payload: Record<string, unknown>;
  basis?: string;
}

export interface ApproveInput {
  /** 二次确认标记：后端要求字面量 true（缺省 → VALIDATION_FAILED） */
  confirmed: true;
  opinion?: string;
}

export interface RejectInput {
  confirmed: true;
  /** 驳回理由，≥5 字 */
  reason: string;
}

export function listApprovals(status?: ApprovalStatus): Promise<ApprovalItem[]> {
  return http
    .get<ApprovalItem[]>('/approvals', { params: status ? { status } : {} })
    .then((r) => r.data);
}

export function createApproval(input: CreateApprovalInput): Promise<ApprovalItem> {
  return http.post<ApprovalItem>('/approvals', input).then((r) => r.data);
}

export function approveApproval(id: string, input: ApproveInput): Promise<ApprovalItem> {
  return http.post<ApprovalItem>(`/approvals/${id}/approve`, input).then((r) => r.data);
}

export function rejectApproval(id: string, input: RejectInput): Promise<ApprovalItem> {
  return http.post<ApprovalItem>(`/approvals/${id}/reject`, input).then((r) => r.data);
}

export function withdrawApproval(id: string): Promise<ApprovalItem> {
  return http.post<ApprovalItem>(`/approvals/${id}/withdraw`).then((r) => r.data);
}
