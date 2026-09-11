/** 人员记录 kind 枚举（V2.4）：唯一来源 + 中文标签（前端 tag 配色按 kind 区分） */
export const STAFF_RECORD_KIND_VALUES = ['attendance', 'reward', 'punish', 'note'] as const;
export type StaffRecordKind = (typeof STAFF_RECORD_KIND_VALUES)[number];

export const STAFF_RECORD_KIND_LABELS: Record<StaffRecordKind, string> = {
  attendance: '考勤',
  reward: '奖励',
  punish: '处罚',
  note: '备注',
};

/** 记录对象类型（V2.4）：V1 限技师（决策 C——店员/agent 名单暂不落地，枚举留扩展点） */
export const STAFF_RECORD_SUBJECT_VALUES = ['technician'] as const;
export type StaffRecordSubject = (typeof STAFF_RECORD_SUBJECT_VALUES)[number];

/** 技师工种枚举（v1.5 §5.4 唯一来源）：改色膜与车衣同技能池；"双技能"不与"双膜套餐"混称 */
export const TECHNICIAN_SKILL_VALUES = ['window_film', 'car_cover', 'color_change'] as const;
export type TechnicianSkill = (typeof TECHNICIAN_SKILL_VALUES)[number];

export const TECHNICIAN_SKILL_LABELS: Record<TechnicianSkill, string> = {
  window_film: '窗膜',
  car_cover: '车衣',
  color_change: '改色膜',
};

/** 独立编造的演示人员配置，不对应实际门店编制或技能分配。 */
export interface SeedTechnician {
  name: string;
  skills: TechnicianSkill[];
}
export const SEED_TECHNICIANS: readonly SeedTechnician[] = [
  { name: '演示技师 A', skills: ['window_film', 'color_change'] },
  { name: '演示技师 B', skills: ['car_cover'] },
  { name: '演示技师 C', skills: ['window_film', 'car_cover'] },
];

/** 历史占位名称：仅用于兼容旧演示种子的清理逻辑。 */
export const PLACEHOLDER_TECHNICIAN_NAMES = ['师傅A', '师傅B', '师傅C', '师傅D', '师傅E'];
