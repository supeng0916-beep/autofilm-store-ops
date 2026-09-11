import { http } from './http';

/** 预约业务类型（v1.5 §5.4，与 backend delivery.constants BUSINESS_TYPE_VALUES 同口径） */
export const BUSINESS_TYPE_VALUES = [
  'window_film',
  'car_cover',
  'color_change',
  'home_film',
] as const;
export type BusinessType = (typeof BUSINESS_TYPE_VALUES)[number];

/** 中文标签（与 backend delivery.constants BUSINESS_TYPE_LABELS 同口径） */
export const BUSINESS_TYPE_LABEL: Record<BusinessType, string> = {
  window_film: '窗膜',
  car_cover: '车衣',
  color_change: '改色膜',
  home_film: '住宅玻璃膜',
};

/** 表单下拉选项（顺序与后端枚举一致） */
export const BUSINESS_TYPE_OPTIONS = BUSINESS_TYPE_VALUES.map((value) => ({
  value,
  label: BUSINESS_TYPE_LABEL[value],
}));

/** 业务类型 → 技师所需工种；home_film 为住宅线独立，不过滤技能池（null） */
export const BUSINESS_TYPE_REQUIRED_SKILL: Record<BusinessType, string | null> = {
  window_film: 'window_film',
  car_cover: 'car_cover',
  color_change: 'color_change',
  home_film: null,
};

/** 预约（M07，P5-01~03） */
export interface Appointment {
  id: string;
  leadId: string | null;
  customerId: string;
  opportunityId: string | null;
  /** 业务类型（v1.5 必填；历史单可能为空） */
  businessType: BusinessType | null;
  serviceItem: string | null;
  workbench: string | null;
  technicianName: string | null;
  technicianDesignated: boolean;
  estHours: number | null;
  startAt: string;
  endAt: string | null;
  promise: string | null;
  managerConfirmed: boolean;
  managerConfirmedBy: string | null;
  managerConfirmedAt: string | null;
  status: 'pending' | 'confirmed' | 'cancelled';
  createdAt: string;
}

export interface TechnicianChange {
  id: string;
  appointmentId: string;
  fromName: string;
  toName: string;
  reason: string | null;
  status: 'pending' | 'confirmed' | 'rejected';
  requestedAt: string;
  confirmMethod: string | null;
  confirmedAt: string | null;
}

export interface CreateAppointmentData {
  /** 客资关联（2026-08-25 起与 customerId 二选一：传 leadId 即可，后端自动查找/建客户档案） */
  leadId?: string;
  customerId?: string;
  opportunityId?: string;
  /** 业务类型（v1.5 契约必填，缺失后端 400） */
  businessType: BusinessType;
  serviceItem: string;
  workbench?: string;
  technicianName?: string;
  technicianDesignated?: boolean;
  estHours?: number;
  startAt: string;
  endAt: string;
  promise?: string;
}

export const appointmentApi = {
  list: () => http.get<Appointment[]>('/appointments').then((r) => r.data),
  get: (id: string) => http.get<Appointment>(`/appointments/${id}`).then((r) => r.data),
  create: (data: CreateAppointmentData) =>
    http.post<{ appointment: Appointment }>('/appointments', data).then((r) => r.data),
  cancel: (id: string) => http.post(`/appointments/${id}/cancel`).then((r) => r.data),
  technicianChanges: (id: string) =>
    http.get<TechnicianChange[]>(`/appointments/${id}/technician-changes`).then((r) => r.data),
  requestTechnicianChange: (id: string, data: { toName: string; reason: string }) =>
    http.post(`/appointments/${id}/technician-change`, data).then((r) => r.data),
  confirmTechnicianChange: (
    id: string,
    changeId: string,
    data: { confirmMethod: 'wechat' | 'phone' | 'onsite'; note?: string },
  ) =>
    http
      .post(`/appointments/${id}/technician-change/${changeId}/confirm`, data)
      .then((r) => r.data),
};
