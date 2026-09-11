/** M09 状态常量（批次1）：回访/售后受理/质保登记/转介绍四类，取值唯一来源 */
export const VISIT_PLAN = { D7: 'd7', D30: 'd30', CUSTOM: 'custom' } as const;
export type VisitPlan = (typeof VISIT_PLAN)[keyof typeof VISIT_PLAN];
export const VISIT_PLAN_VALUES = Object.values(VISIT_PLAN) as [VisitPlan, ...VisitPlan[]];
export const VISIT_PLAN_LABEL: Record<VisitPlan, string> = {
  d7: '7天回访',
  d30: '30天回访',
  custom: '自定义',
};

export const VISIT_STATUS = { PENDING: 'pending', DONE: 'done', SKIPPED: 'skipped' } as const;
export type VisitStatus = (typeof VISIT_STATUS)[keyof typeof VISIT_STATUS];

export const SR_KIND = {
  CONSULT: 'consult',
  RECHECK: 'recheck',
  COMPLAINT: 'complaint',
  OTHER: 'other',
} as const;
export type SrKind = (typeof SR_KIND)[keyof typeof SR_KIND];
export const SR_KIND_VALUES = Object.values(SR_KIND) as [SrKind, ...SrKind[]];
export const SR_KIND_LABEL: Record<SrKind, string> = {
  consult: '咨询',
  recheck: '复检',
  complaint: '投诉',
  other: '其他',
};

export const SR_STATUS = {
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  RESOLVED: 'resolved',
} as const;
export type SrStatus = (typeof SR_STATUS)[keyof typeof SR_STATUS];

export const WARRANTY_STATUS = { PENDING: 'pending', REGISTERED: 'registered' } as const;
export const REFERRAL_STATUS = { PENDING: 'pending', WON: 'won' } as const;
