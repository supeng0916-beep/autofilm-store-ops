/** 订单确认单状态（批次1，可选步骤不作施工单闸门——已拍板 2026-09-01） */
export const ORDER_STATUS = { DRAFT: 'draft', CONFIRMED: 'confirmed' } as const;
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

export const PAY_METHOD_VALUES = ['wechat', 'alipay', 'cash', 'card', 'other'] as const;
export const PAY_METHOD_LABEL: Record<string, string> = {
  wechat: '微信',
  alipay: '支付宝',
  cash: '现金',
  card: '刷卡',
  other: '其他',
};
