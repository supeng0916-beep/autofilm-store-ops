import { http } from './http';

/** 施工单（M08，P5-04~06） */
export type WorkOrderStage =
  'pending' | 'in_progress' | 'self_check_done' | 'recheck_done' | 'delivered';

export interface WorkOrder {
  id: string;
  orderNo: string;
  appointmentId: string | null;
  customerId: string | null;
  leadId: string | null;
  serviceItem: string | null;
  workbench: string | null;
  technicianName: string | null;
  /** 住宅膜勘测（批次3）：仅 home_film 有值 */
  homeSurvey: {
    glassArea?: string;
    orientation?: string;
    glassMaterial?: string;
    propertyCondition?: string;
  } | null;
  stage: WorkOrderStage;
  photos: Array<{ path: string; originalName?: string; note?: string; at: string }> | null;
  abnormal: Array<{ description: string; at: string; occurredAt?: string }> | null;
  rework: boolean;
  reworkRecords: Array<{ reason: string; at: string; note?: string }> | null;
  selfCheck: { byName: string; at: string; occurredAt?: string; note?: string } | null;
  recheck: { byName: string; at: string; occurredAt?: string; note?: string } | null;
  deliveredAt: string | null;
  deliveredBy: string | null;
  warrantyRef: string | null;
  careNotes: {
    draft: string;
    sources: Array<{ title: string; source: string | null }>;
    generatedAt: string;
    confirmed?: { byName: string; at: string; content: string };
  } | null;
  caseRequest: { authorized: boolean; method?: string; note?: string; at: string } | null;
  backfilled: boolean;
  backfillForAt: string | null;
  createdAt: string;
}

export const WO_STAGE_LABEL: Record<WorkOrderStage, string> = {
  pending: '待入场',
  in_progress: '施工中',
  self_check_done: '自检完成',
  recheck_done: '复检完成',
  delivered: '已交付',
};

export const workOrderApi = {
  list: (stage?: WorkOrderStage) =>
    http.get<WorkOrder[]>('/work-orders', { params: stage ? { stage } : {} }).then((r) => r.data),
  get: (id: string) => http.get<WorkOrder>(`/work-orders/${id}`).then((r) => r.data),
  /** technicianName：2026-08-28 bug3——预约未指定技师时建单必填（后端硬校验） */
  create: (appointmentId: string, technicianName?: string, homeSurvey?: WorkOrder['homeSurvey']) =>
    http
      .post<WorkOrder>('/work-orders', {
        appointmentId,
        ...(technicianName ? { technicianName } : {}),
        ...(homeSurvey ? { homeSurvey } : {}),
      })
      .then((r) => r.data),
  start: (id: string) => http.post(`/work-orders/${id}/start`).then((r) => r.data),
  selfCheck: (id: string, data: { note?: string; occurredAt?: string }) =>
    http.post(`/work-orders/${id}/self-check`, data).then((r) => r.data),
  recheck: (id: string, data: { note?: string; occurredAt?: string }) =>
    http.post(`/work-orders/${id}/recheck`, data).then((r) => r.data),
  rework: (id: string, data: { reason: string; note?: string }) =>
    http.post(`/work-orders/${id}/rework`, data).then((r) => r.data),
  deliver: (id: string, data: { warrantyRef?: string; note?: string }) =>
    http.post(`/work-orders/${id}/deliver`, data).then((r) => r.data),
  addPhoto: (id: string, formData: FormData) =>
    http.post(`/work-orders/${id}/photos`, formData).then((r) => r.data),
  addAbnormal: (id: string, data: { description: string }) =>
    http.post(`/work-orders/${id}/abnormal`, data).then((r) => r.data),
  draftCareNotes: (id: string) =>
    http.get<WorkOrder>(`/work-orders/${id}/care-notes/draft`).then((r) => r.data),
  confirmCareNotes: (id: string, content: string) =>
    http.post(`/work-orders/${id}/care-notes/confirm`, { content }).then((r) => r.data),
  caseRequest: (id: string, data: { authorized: boolean; method?: string; note?: string }) =>
    http.post(`/work-orders/${id}/case-request`, data).then((r) => r.data),
};
