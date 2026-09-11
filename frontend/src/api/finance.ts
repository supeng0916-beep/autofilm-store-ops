import { http } from './http';

/** 财务收支（批次2 T6，M10）：流水只增不改；金额分存储，页面按元显示 */
export const DIRECTION_LABEL: Record<string, string> = { income: '收入', expense: '支出' };

export const EXPENSE_CATEGORY_LABEL: Record<string, string> = {
  material: '材料',
  rent: '房租',
  salary: '工资',
  advertising: '广告投放',
  equipment: '设备',
  other: '其他',
};

export const INCOME_CATEGORY_LABEL: Record<string, string> = {
  deal_receipt: '成交收款',
  deposit: '定金',
  other: '其他',
};

/** 流水条目（与后端 FinanceEntry 对齐） */
export interface FinanceEntry {
  id: string;
  direction: 'income' | 'expense';
  category: string;
  amountFen: number;
  occurredOn: string;
  remark: string | null;
  leadId: string | null;
  createdAt: string;
}

export interface CreateFinanceInput {
  direction: 'income' | 'expense';
  category: string;
  amountFen: number;
  occurredOn: string;
  remark?: string;
  leadId?: string;
}

export const financeApi = {
  /** 列表：方向与时间窗过滤（occurredOn 倒序） */
  list: (params?: { direction?: string; from?: string; to?: string }) =>
    http.get<FinanceEntry[]>('/finance/entries', { params }).then((r) => r.data),

  /** 登记流水（只增不改；金额分） */
  create: (data: CreateFinanceInput) =>
    http.post<FinanceEntry>('/finance/entries', data).then((r) => r.data),
};
