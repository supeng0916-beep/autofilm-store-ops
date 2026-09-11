import { http } from './http';

/** 经营复盘（M10 最小版） */

export interface AnalyticsOverview {
  range: { from: string | null; to: string | null; scopedToOwner: boolean };
  funnel: {
    total: number;
    touched: number;
    visited: number;
    won: number;
    lost: number;
    touchRate: number;
    visitRate: number;
    closeRate: number;
    avgCloseDays: number | null;
  };
  byStage: Array<{ stage: string; count: number }>;
  byFinalStatus: Array<{ stage: string; count: number }>;
  revenueFen: number;
  avgDealFen: number | null;
  bySource: Array<{ platform: string; total: number; won: number; revenueFen: number }>;
  lostReasons: Array<{ reason: string; count: number }>;
  workOrders: {
    total: number;
    delivered: number;
    inProgress: number;
    reworkCount: number;
    reworkRate: number;
    byTechnician: Array<{
      name: string;
      total: number;
      delivered: number;
      rework: number;
      revenueFen: number;
    }>;
  };
  /** 批次2 T5/T8：财务/内容归因/画像 */
  finance: { incomeFen: number; expenseFen: number; netFen: number };
  /** 批次4 毛利估算：已录成本的已确认订单 Σ(收款−成本)；无数据为 null（前端显"—"） */
  grossProfitFen: number | null;
  contentAttribution: Array<{
    contentId: string;
    title: string | null;
    platform: string | null;
    costFen: number;
    leadCount: number;
    wonCount: number;
    revenueFen: number;
  }>;
  profile: {
    gender: Array<{ value: string; count: number }>;
    ageBand: Array<{ value: string; count: number }>;
  };
  /** 批次6 复购客户：范围内成交≥2 条客资的客户数（按 customerId 分桶，无 customerId 不计） */
  repeatCustomerCount: number;
}

export const STAGE_LABEL: Record<string, string> = {
  new: '新客资',
  contacted: '已触达',
  communicating: '沟通中',
  quoted: '已报价',
  visit_booked: '已预约',
  visit_done: '已到店',
  active: '进行中',
  silence: '沉默',
  lost_pending: '待审流失',
  lost: '已流失',
  won: '已成交',
  invalid: '无效',
};

/** 控制面板（首页）聚合数据 */
export interface DashboardData {
  greetingName: string;
  metrics: {
    todayNewLeads: number;
    slaDue: number;
    pendingApprovals: number;
    todayAppointments: number;
    monthRevenueFen: number;
    monthWonCount: number;
  };
  todos: Array<{
    kind: 'sla' | 'approval' | 'follow_up' | 'recheck';
    title: string;
    meta: string;
    link: string;
  }>;
  scopedToOwner: boolean;
}

export const analyticsApi = {
  dashboard: () => http.get<DashboardData>('/analytics/dashboard').then((r) => r.data),
  overview: (params?: { from?: string; to?: string }) =>
    http.get<AnalyticsOverview>('/analytics/overview', { params }).then((r) => r.data),
};
