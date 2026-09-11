import { http } from './http';

/** 订单确认单（批次1 Task 7 端点）：报价快照＋定金尾款留痕；金额一律分为单位。
 * 状态机：draft（待客户确认）→ confirmed（customerConfirmedAt 落确认时间）。 */
export interface OrderConfirmation {
  id: string;
  leadId: string;
  appointmentId: string | null;
  /** 产品/服务范围（原文） */
  products: string;
  /** 报价快照（多行原文，报价单文字摘要） */
  quoteSnapshot: string;
  /** 优惠说明（选填） */
  discountNote: string | null;
  /** 定金（分） */
  depositFen: number;
  /** 尾款（分） */
  balanceFen: number;
  /** 材料成本（分，批次4 毛利估算）：选填，未录入为 null（复盘毛利口径不计入） */
  materialCostFen: number | null;
  /** 付款方式：wechat/alipay/cash/card/other（后端 PAY_METHOD_VALUES） */
  payMethod: string | null;
  status: 'draft' | 'confirmed';
  customerConfirmedAt: string | null;
  createdAt: string;
}

/** 欠款清单行（批次5 Task 5 端点）：尾款未清的已确认单 + 客资称呼/电话。
 * 订单总额 = depositFen + balanceFen（页面展示口径），金额一律分为单位。 */
export interface ArrearsRow {
  id: string;
  leadId: string;
  /** 客户称呼（客资缺失/未录为 null） */
  customerName: string | null;
  /** 联系电话（现有可见口径原值，仓库无电话角色脱敏先例） */
  phone: string | null;
  /** 已收定金（分） */
  depositFen: number;
  /** 待收尾款（分） */
  balanceFen: number;
  /** 客户确认时间 */
  customerConfirmedAt: string;
}

export const orderApi = {
  /** 欠款提醒（GET /order-confirmations/arrears，m03:view）：confirmed 且尾款>0 清单，
   * 按确认时间升序（欠得最久在前）；财务页「欠款提醒」面板数据源 */
  arrears: () => http.get<ArrearsRow[]>('/order-confirmations/arrears').then((r) => r.data),
  /** 按客资查确认单（GET /order-confirmations?leadId=）：后端返回数组（createdAt desc），
   * 同客资唯一约束下至多一单——取首条，无单返回 null */
  byLead: (leadId: string) =>
    http
      .get<OrderConfirmation[]>('/order-confirmations', { params: { leadId } })
      .then((r) => r.data[0] ?? null),
  /** 创建（POST /order-confirmations，m03:edit）：客资须已成交，重复创建 409 */
  create: (data: {
    leadId: string;
    products: string;
    quoteSnapshot: string;
    discountNote?: string;
    depositFen: number;
    balanceFen: number;
    /** 材料成本（分，批次4）：选填，不传即"未录成本" */
    materialCostFen?: number;
    payMethod?: string;
  }) => http.post<OrderConfirmation>('/order-confirmations', data).then((r) => r.data),
  /** 客户确认（POST /order-confirmations/:id/confirm，m03:edit）：仅 draft 可确认，重复 409 */
  confirm: (id: string) =>
    http.post<OrderConfirmation>(`/order-confirmations/${id}/confirm`).then((r) => r.data),
};
