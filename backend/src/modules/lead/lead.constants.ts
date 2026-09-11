/** 客资事件 kind 清单（D-P3-9 派发解析留痕＋各状态机动作）：
 * 代码常量集合约束，不做 DB 枚举（D-P3 设计决策 2），测试校验完整性。 */
export const LEAD_EVENT_KIND = {
  IMPORTED: 'imported', // 导入/登记入库
  MANUAL_REGISTERED: 'manual_registered', // 手工登记入库（2026-08-25 老板需求，无导入批次）
  DISPATCH_PARSED: 'dispatch_parsed', // 派发文本解析落库
  DUP_LINKED: 'dup_linked', // 判定重复并关联主客资
  ASSIGNED: 'assigned', // 分配负责人
  STAGE_CHANGED: 'stage_changed', // 作业阶段流转
  INTENT_PROPOSED: 'intent_proposed', // 意向分级建议（AI 草稿态）
  INTENT_CONFIRMED: 'intent_confirmed', // 意向分级人工确认
  SILENCE_MARKED: 'silence_marked', // 标记沉默
  REVIVED: 'revived', // 沉默唤醒
  FOLLOWUP_RECORDED: 'followup_recorded', // 跟进记录
  DRAFT_CREATED: 'draft_created', // 话术草稿生成
  DRAFT_COPIED: 'draft_copied', // 草稿复制（≠已发送）
  SEND_RECORDED: 'send_recorded', // 实际发送留痕
  CHURN_PROPOSED: 'churn_proposed', // 流失建议
  CHURN_DECIDED: 'churn_decided', // 流失判定
  CHURN_REMIND_14D: 'churn_remind_14d', // 流失 14 天提醒
  REOPENED: 'reopened', // 重新开启
  WON: 'won', // 成交
  INVALID: 'invalid', // 无效
  MERGED: 'merged', // 客资合并
  CLAIM: 'claim', // 认领
  SLA_REMIND: 'sla_remind', // SLA 提醒
  SLA_BREACH: 'sla_breach', // SLA 违约
  SLA_ESCALATE: 'sla_escalate', // SLA 升级
  PAUSED: 'paused', // 暂停
  RESUMED: 'resumed', // 恢复
  TAKEOVER: 'takeover', // 接管
} as const;
export type LeadEventKind = (typeof LEAD_EVENT_KIND)[keyof typeof LEAD_EVENT_KIND];

/** 派发解析器版本（D-P3-9 留痕；升级时递增，不覆盖旧记录） */
export const DISPATCH_PARSER_VERSION = 1;

/** 业务类型：车膜/家膜（D-P3 字段字典 business_type） */
export const LEAD_BUSINESS_TYPES = ['auto_film', 'home_film'] as const;
export type LeadBusinessType = (typeof LEAD_BUSINESS_TYPES)[number];

/** 微信类型：真实号/虚拟二维码/未知（D-P3 字段字典 wechat_type） */
export const WECHAT_TYPES = ['real', 'virtual_ewm', 'unknown'] as const;
export type WechatType = (typeof WECHAT_TYPES)[number];

/** 流失原因枚举（D-P3-7）：价格/竞品/需求消失/无法联系/其他（选「其他」须附说明 note） */
export const CHURN_REASON = {
  PRICE: 'price',
  COMPETITOR: 'competitor',
  NEED_GONE: 'need_gone',
  UNREACHABLE: 'unreachable',
  OTHER: 'other',
} as const;
export type ChurnReason = (typeof CHURN_REASON)[keyof typeof CHURN_REASON];

/** 流失原因展示标签（落库/事件用英文码，展示层映射中文） */
export const CHURN_REASON_LABELS: Record<ChurnReason, string> = {
  price: '价格',
  competitor: '竞品',
  need_gone: '需求消失',
  unreachable: '无法联系',
  other: '其他',
};

/** 客户画像（批次2）：选填、分段枚举；画像字段不参与分配/SLA 逻辑，仅记录与统计 */
export const GENDER_VALUES = ['male', 'female'] as const;
export const GENDER_LABEL: Record<string, string> = { male: '男', female: '女' };
export const AGE_BAND_VALUES = ['18-25', '26-35', '36-45', '46-55', '55+'] as const;
