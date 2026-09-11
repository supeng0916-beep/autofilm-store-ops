/** 预约状态（P5-01）：pending 待店长确认 → confirmed 已确认；cancelled 终态（冲突检测不再占用档期） */
export const APPOINTMENT_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
} as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUS)[keyof typeof APPOINTMENT_STATUS];

export const APPOINTMENT_STATUS_VALUES = Object.values(APPOINTMENT_STATUS) as [
  AppointmentStatus,
  ...AppointmentStatus[],
];

/** 技师替换状态（P5-02）：pending → confirmed（客户确认后生效）/ rejected */
export const TECH_CHANGE_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
} as const;

/** 客户确认方式（P5-02：记录确认方式与时间） */
export const CONFIRM_METHOD_VALUES = ['wechat', 'phone', 'onsite'] as const;
export type ConfirmMethod = (typeof CONFIRM_METHOD_VALUES)[number];

export const CONFIRM_METHOD_LABEL: Record<ConfirmMethod, string> = {
  wechat: '微信确认',
  phone: '电话确认',
  onsite: '到店确认',
};
