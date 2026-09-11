import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import {
  BUSINESS_TYPE_LABELS,
  BUSINESS_TYPE_REQUIRED_SKILL,
  type BusinessType,
} from './delivery.constants';

/** 技能校验所需技师字段（Prisma Technician 的最小投影，测试可造桩） */
export interface TechnicianSkillRecord {
  active: boolean;
  skills: string[];
}

/** 派工技能池硬校验（v1.5 §5.4 确定性规则；预约创建/技师替换/建施工单三路径共用）：
 * 未指定技师、业务类型为空（历史单）或无技能约束（home_film 独立线）不校验；
 * 技师不存在/停用/技能不覆盖 → 422 TECHNICIAN_SKILL_MISMATCH。
 * 2026-08-28 P1 修复：原先仅预约侧私有方法持有该规则，建单现场选技师路径漏校验。 */
export async function assertTechnicianSkill(
  technicianName: string | null | undefined,
  businessType: BusinessType | null | undefined,
  findTechnician: (name: string) => Promise<TechnicianSkillRecord | null>,
): Promise<void> {
  if (!technicianName || !businessType) return;
  const required = BUSINESS_TYPE_REQUIRED_SKILL[businessType];
  if (required === null) return;
  const tech = await findTechnician(technicianName);
  if (!tech || !tech.active || !tech.skills.includes(required)) {
    throw new AppException(
      ErrorCode.TECHNICIAN_SKILL_MISMATCH,
      `技师 ${technicianName} 不能承接${BUSINESS_TYPE_LABELS[businessType]}工单（技能池不匹配或已停用）`,
      { technicianName, businessType },
    );
  }
}
