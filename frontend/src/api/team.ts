import { http } from './http';
import type { WorkOrderStage } from './workOrder';

/** 人机团队（M08，V2.4）：技师档案/忙闲/指标 + Agent 花名册 + 考勤奖惩记录（GET m08:view；
 * 写端点后端按 boss|store_manager 角色硬校验，前端按钮显隐近似口径 approval:decide） */

export type StaffRecordKind = 'attendance' | 'reward' | 'punish' | 'note';

/** 记录 kind 中文标签（唯一来源 backend team.constants，前端同口径维护） */
export const STAFF_RECORD_KIND_LABEL: Record<StaffRecordKind, string> = {
  attendance: '考勤',
  reward: '奖励',
  punish: '处罚',
  note: '备注',
};

/** kind → el-tag 语义色：考勤蓝/奖绿/惩红/备注灰 */
export const STAFF_RECORD_KIND_TAG: Record<
  StaffRecordKind,
  'primary' | 'success' | 'danger' | 'info'
> = {
  attendance: 'primary',
  reward: 'success',
  punish: 'danger',
  note: 'info',
};

/** 技师工种（与 backend team.constants 同口径） */
export const TECHNICIAN_SKILL_OPTIONS = ['window_film', 'car_cover', 'color_change'] as const;
export const TECHNICIAN_SKILL_LABEL: Record<string, string> = {
  window_film: '窗膜',
  car_cover: '车衣',
  color_change: '改色膜',
};

/** 技师卡（overview 上区）：currentWorkOrder 非空=有活（最新一张非终态施工单，2026-08-28 口径修复） */
export interface TechnicianCard {
  id: string;
  kind: 'technician';
  name: string;
  /** 工种枚举数组（V1.5 契约，window_film/car_cover/color_change；空数组=未维护） */
  skills: string[];
  active: boolean;
  currentWorkOrder: { orderNo: string; stage: WorkOrderStage } | null;
  stats: { total: number; delivered: number; rework: number; revenueFen: number };
}

/** Agent 花名册行（overview 中区）：registry 代码事实 + ai_tasks 近 30 天聚合 */
export interface AgentRow {
  taskType: string;
  skillName: string;
  kind: 'agent';
  recent30d: {
    total: number;
    /** 完成率 0-1（分母 0 时置 0） */
    doneRate: number;
    /** 平均耗时秒（无样本为 null） */
    avgSeconds: number | null;
    lastRunAt: string | null;
  };
}

/** 人员记录行（overview 下区，近 20 条）：展示名由服务层拼装 */
export interface StaffRecordRow {
  id: string;
  subjectType: string;
  subjectId: string;
  subjectName: string | null;
  kind: string;
  content: string;
  occurredAt: string;
  recordedBy: string;
  recorderName: string | null;
  createdAt: string;
}

export interface TeamOverview {
  technicians: TechnicianCard[];
  agents: AgentRow[];
  records: StaffRecordRow[];
}

/** 总览（GET /team/overview，m08:view） */
export const overview = () => http.get<TeamOverview>('/team/overview').then((r) => r.data);

/** 新建技师（POST /team/technicians；boss|store_manager） */
export const createTechnician = (data: { name: string; skills?: string[] }) =>
  http.post('/team/technicians', data).then((r) => r.data);

/** 更新技师（PATCH /team/technicians/:id）：改名/工种数组（null 清空为 []）/停用；boss|store_manager */
export const updateTechnician = (
  id: string,
  data: { name?: string; skills?: string[] | null; active?: boolean },
) => http.patch(`/team/technicians/${id}`, data).then((r) => r.data);

/** 录入人员记录（POST /team/records）：occurredAt 必填 ISO（Z 格式，补录口径）；boss|store_manager */
export const createRecord = (data: {
  subjectId: string;
  kind: StaffRecordKind;
  content: string;
  occurredAt: string;
}) => http.post('/team/records', data).then((r) => r.data);
