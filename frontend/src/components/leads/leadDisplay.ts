// 客资详情共用展示常量与格式化（P3-06 字段口径 / V2.5 Task3 拆分）：
// 仅前端展示映射，业务语义以后端字段字典为准；被详情页编排层与各子面板共用。
/** 阶段标签 */
export const STAGE_LABELS: Record<string, string> = {
  new: '新线索',
  contacted: '已触达',
  communicating: '沟通中',
  quoted: '已报价',
  visit_booked: '已预约到店',
  visit_done: '已到店',
};

/** 最终状态标签 */
export const FINAL_STATUS_LABELS: Record<string, string> = {
  active: '在跟',
  silence: '沉默',
  lost_pending: '待流失',
  lost: '流失',
  won: '成交',
  invalid: '无效',
};

/** 意向等级标签 */
export const INTENT_LABELS: Record<string, string> = {
  high: '高',
  mid: '中',
  low: '低',
  pending: '待定',
};

/** 流失原因标签 */
export const CHURN_REASONS: Record<string, string> = {
  price: '价格',
  competitor: '竞品',
  need_gone: '需求消失',
  unreachable: '无法联系',
  other: '其他',
};

/** 时间线事件类型标签 */
export const EVENT_LABELS: Record<string, string> = {
  imported: '导入登记',
  dispatch_parsed: '派发解析',
  dup_linked: '重复关联',
  assigned: '分配负责人',
  stage_changed: '阶段流转',
  intent_proposed: '意向建议',
  intent_confirmed: '意向确认',
  silence_marked: '标记沉默',
  revived: '沉默唤醒',
  followup_recorded: '跟进记录',
  draft_created: '草稿改写',
  draft_copied: '草稿复制',
  send_recorded: '实际发送',
  churn_proposed: '流失建议',
  churn_decided: '流失判定',
  churn_remind_14d: '流失提醒',
  reopened: '重新开启',
  won: '成交',
  invalid: '无效',
  merged: '合并',
  claim: '认领',
  sla_remind: 'SLA 提醒',
  sla_breach: 'SLA 违约',
  sla_escalate: 'SLA 升级',
  paused: '暂停',
  resumed: '恢复',
  takeover: '接管',
};

/** 跟进记录提交载荷（详情页作业动作面板 → 编排层，字段口径对齐 leadsApi.recordFollowUp） */
export interface FollowUpPayload {
  result: string;
  nextAction: string;
  nextFollowUpAt: string;
  waitCustomer: boolean;
}

/** 本地化时间（缺失回退 — ） */
export function fmt(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN');
}
