/** 财务收支常量（批次2）：append-only 流水，分类枚举唯一来源 */
export const FINANCE_DIRECTION = { INCOME: 'income', EXPENSE: 'expense' } as const;
export type FinanceDirection = (typeof FINANCE_DIRECTION)[keyof typeof FINANCE_DIRECTION];

export const EXPENSE_CATEGORY = {
  MATERIAL: 'material',
  RENT: 'rent',
  SALARY: 'salary',
  ADVERTISING: 'advertising',
  EQUIPMENT: 'equipment',
  OTHER: 'other',
} as const;
export const EXPENSE_CATEGORY_VALUES = Object.values(EXPENSE_CATEGORY) as [string, ...string[]];
export const EXPENSE_CATEGORY_LABEL: Record<string, string> = {
  material: '材料',
  rent: '房租',
  salary: '工资',
  advertising: '广告投放',
  equipment: '设备',
  other: '其他',
};

export const INCOME_CATEGORY = {
  DEAL_RECEIPT: 'deal_receipt',
  DEPOSIT: 'deposit',
  OTHER: 'other',
} as const;
export const INCOME_CATEGORY_VALUES = Object.values(INCOME_CATEGORY) as [string, ...string[]];
export const INCOME_CATEGORY_LABEL: Record<string, string> = {
  deal_receipt: '成交收款',
  deposit: '定金',
  other: '其他',
};
