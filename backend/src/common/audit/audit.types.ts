/** 审计输入：谁/何时/对哪个对象/做了什么/前后值摘要/IP（规范 S08/SEC02）。
 * actorId 允许为空：登录失败等场景尚无会话用户。 */
export interface AuditInput {
  actorId?: string;
  actorName?: string;
  action: string;
  objectType: string;
  objectId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}
