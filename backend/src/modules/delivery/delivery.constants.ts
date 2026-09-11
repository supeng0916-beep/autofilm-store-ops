import type { TechnicianSkill } from '../team/team.constants';

/** 业务类型（v1.5 §3/M08）：改色膜沿用车衣技能池但工时单独校准；住宅玻璃膜独立业务线（M12） */
export const BUSINESS_TYPE_VALUES = [
  'window_film',
  'car_cover',
  'color_change',
  'home_film',
] as const;
export type BusinessType = (typeof BUSINESS_TYPE_VALUES)[number];

export const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  window_film: '窗膜',
  car_cover: '车衣',
  color_change: '改色膜',
  home_film: '住宅玻璃膜',
};

/** 业务类型 → 所需技师工种；home_film 无汽车技能池约束（v1.5 M12 独立线，不套用汽车规则，null=不校验） */
export const BUSINESS_TYPE_REQUIRED_SKILL: Record<BusinessType, TechnicianSkill | null> = {
  window_film: 'window_film',
  car_cover: 'car_cover',
  color_change: 'color_change',
  home_film: null,
};

/** 工位名归一化（2026-08-28 UI 测试 #5）：「工位A」「工位 a 」「A」实为同一物理工位，
 * 手填自由文本写法漂移会绕过同工位冲突检测（同位双排期实测放行）。
 * 归一规则：去首尾与内部空白（含全角空格）→ 英文统一大写 → 去掉前缀「工位/STATION/BAY」。
 * 归一后为空串则返回原文（交回 min(1) 校验拒绝）。 */
export function normalizeWorkbench(raw: string): string {
  const collapsed = raw.replace(/[\s\u3000]+/g, '').toUpperCase();
  const stripped = collapsed.replace(/^(?:工位|STATION|BAY)+/i, '');
  return stripped || raw.trim();
}
