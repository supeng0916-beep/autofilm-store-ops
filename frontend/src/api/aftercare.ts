import { http } from './http';

/** 回访计划标签（与后端 aftercare.states VISIT_PLAN_LABEL 同口径） */
export const VISIT_PLAN_LABEL: Record<string, string> = {
  d7: '7天回访',
  d30: '30天回访',
  custom: '自定义',
};

/** 售后受理类型标签（与后端 aftercare.states SR_KIND_LABEL 同口径） */
export const SR_KIND_LABEL: Record<string, string> = {
  consult: '咨询',
  recheck: '复检',
  complaint: '投诉',
  other: '其他',
};

/** 回访计划（M09 批次1；字段与后端 Prisma AftercareVisit 一致） */
export interface AftercareVisit {
  id: string;
  workOrderId: string;
  customerId: string | null;
  /** d7/d30/custom（手工创建固定 custom，后端写死） */
  plan: string;
  dueAt: string;
  /** pending/done/skipped */
  status: string;
  executedBy: string | null;
  executedAt: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 售后受理（M09 批次1；投诉创建即通知老板——后端钩子） */
export interface ServiceRequest {
  id: string;
  customerId: string | null;
  leadId: string | null;
  workOrderId: string | null;
  /** consult/recheck/complaint/other */
  kind: string;
  content: string;
  /** open/in_progress/resolved */
  status: string;
  handlerUserId: string | null;
  resolvedAt: string | null;
  result: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 电子质保登记（M09 批次1）：仅记录登记事实，不构成理赔承诺（任务书红线） */
export interface WarrantyRegistration {
  id: string;
  workOrderId: string | null;
  customerId: string | null;
  productModel: string | null;
  registrationNo: string | null;
  registeredAt: string | null;
  /** pending/registered */
  status: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 转介绍登记（M09 批次1）：介绍人客户 → 新客资，成交后人工标 won */
export interface ReferralRecord {
  id: string;
  referrerCustomerId: string;
  referredLeadId: string | null;
  referredCustomerId: string | null;
  /** pending/won */
  status: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 客户评价（M09 缺口补齐批次 Task 3；字段与后端 Prisma CustomerReview 一致）：
 * 交付后评分与评语登记，append-only——创建后不可改不可删 */
export interface CustomerReview {
  id: string;
  customerId: string | null;
  leadId: string | null;
  workOrderId: string | null;
  /** 1-5 星 */
  score: number;
  content: string | null;
  reviewedAt: string;
  createdBy: string | null;
  createdAt: string;
}

export const aftercareApi = {
  visits: (status?: string) =>
    http
      .get<AftercareVisit[]>('/aftercare/visits', { params: status ? { status } : {} })
      .then((r) => r.data),
  createVisit: (data: { workOrderId: string; dueAt: string; note?: string }) =>
    http.post('/aftercare/visits', data).then((r) => r.data),
  executeVisit: (id: string, note?: string) =>
    http.post(`/aftercare/visits/${id}/execute`, note ? { note } : {}).then((r) => r.data),
  skipVisit: (id: string, note?: string) =>
    http.post(`/aftercare/visits/${id}/skip`, note ? { note } : {}).then((r) => r.data),
  serviceRequests: (params?: { status?: string; kind?: string }) =>
    http.get<ServiceRequest[]>('/aftercare/service-requests', { params }).then((r) => r.data),
  createServiceRequest: (data: {
    kind: string;
    content: string;
    customerId?: string;
    workOrderId?: string;
  }) => http.post('/aftercare/service-requests', data).then((r) => r.data),
  updateServiceRequest: (
    id: string,
    data: Partial<{ status: string; handlerUserId: string; result: string }>,
  ) => http.patch(`/aftercare/service-requests/${id}`, data).then((r) => r.data),
  warranties: () =>
    http.get<WarrantyRegistration[]>('/aftercare/warranty-registrations').then((r) => r.data),
  createWarranty: (data: Partial<WarrantyRegistration>) =>
    http.post('/aftercare/warranty-registrations', data).then((r) => r.data),
  registerWarranty: (id: string) =>
    http.post(`/aftercare/warranty-registrations/${id}/register`, {}).then((r) => r.data),
  referrals: () => http.get<ReferralRecord[]>('/aftercare/referrals').then((r) => r.data),
  createReferral: (data: { referrerCustomerId: string; referredLeadId?: string; note?: string }) =>
    http.post('/aftercare/referrals', data).then((r) => r.data),
  markReferralWon: (id: string) =>
    http.post(`/aftercare/referrals/${id}/mark-won`, {}).then((r) => r.data),
  reviews: () => http.get<CustomerReview[]>('/aftercare/reviews').then((r) => r.data),
  createReview: (data: {
    score: number;
    customerId?: string;
    leadId?: string;
    workOrderId?: string;
    content?: string;
  }) => http.post('/aftercare/reviews', data).then((r) => r.data),
};
