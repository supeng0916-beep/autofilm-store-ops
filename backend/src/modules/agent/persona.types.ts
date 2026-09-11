/** Agent persona 枚举与显示名（V1.5）：boss/manager 两技能包，sales/general 沿用销售技能；
 * persona 只决定技能包与关注点，数据可见范围始终按 actor 实际权限过滤（spec §3.2 铁律）。 */
export const AGENT_PERSONAS = ['boss', 'manager', 'sales', 'general'] as const;
export type AgentPersona = (typeof AGENT_PERSONAS)[number];

export const PERSONA_DISPLAY: Record<AgentPersona, string> = {
  boss: '老板助手',
  manager: '店长助手',
  sales: '销售助手',
  general: '门店助手',
};

export const PERSONA_MAP_KEY = 'agent.persona.map';
