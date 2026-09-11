/** 脱敏演示账号声明（唯一事实源）：seed-accounts.ts 据此权威同步角色关联；
 * test/rbac.spec.ts「老板娘与老板同权限」守卫直接引用本文件断言账号一致性。
 * 从 seed-accounts.ts 抽出为纯数据模块——导入零副作用（原脚本顶层即执行
 * main() 连库，测试直接导入会误触发种子），沿用 seed-knowledge.data.ts 惯例。 */

export interface RealAccount {
  username: string;
  displayName: string;
  /** 角色码（可多角色：权限并集） */
  roles: string[];
  note: string;
}

/** 两个虚构经营者账号均使用 boss 角色，用于验证权限一致性。 */
export const REAL_ACCOUNTS: RealAccount[] = [
  { username: 'demo-owner-a', displayName: '老板', roles: ['boss'], note: '经营决策/关键审批' },
  {
    username: 'demo-owner-b',
    displayName: '老板娘',
    roles: ['boss'],
    note: '与老板同权限（经营决策/关键审批）+施工拍照反馈',
  },
  { username: 'demo-sales-a', displayName: '销售甲', roles: ['sales_ops'], note: '销售' },
  { username: 'demo-sales-b', displayName: '销售乙', roles: ['sales_ops'], note: '销售' },
  {
    username: 'demo-manager',
    displayName: '店长甲（店长）',
    roles: ['store_manager', 'recorder'],
    note: '店长+施工录入（记录员）',
  },
];
