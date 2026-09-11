/** 权限点与角色映射：唯一依据 docs/PERMISSION_MATRIX.md（已定稿）。
 * ✅ 项授予对应动作权限点；🔶 有条件项：授予权限点，数据范围约束（本人负责/本店等）P3+ 实现。
 * ❌ 项一律不授权。技师不设账号（矩阵 §1）。
 * 矩阵变更必须走正式变更流程：改本文件 + 评审 + 更新 PERMISSION_MATRIX.md。 */

export const ROLE_CODES = ['boss', 'store_manager', 'sales_ops', 'recorder', 'sys_admin'] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

/** 权限点：模块×动作（view/edit/approve/export）+ 系统特权 */
export const PERMISSIONS = [
  // 业务模块（M01–M12）
  'm01:view',
  'm01:edit',
  'm02:view',
  'm02:edit',
  'm02:approve',
  'm03:view',
  'm03:edit',
  'm04:view',
  'm05:view',
  'm05:edit',
  'm06:view',
  'm06:edit',
  'm06:approve',
  'm07:view',
  'm07:edit',
  'm07:approve',
  'm08:view',
  'm08:edit',
  'm08:approve',
  'm09:view',
  'm09:edit',
  'm10:view',
  'm10:edit',
  'm11:view',
  'm11:edit',
  'm11:approve',
  'm12:view',
  'm12:edit',
  // 系统特权
  'system:manage',
  'audit:view',
  'sensitive:export',
  // 审批队列
  'approval:view',
  'approval:request',
  'approval:decide',
  // AI 通道
  'ai:cost:view', // AI 通道成本查看
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL_MODULE_VIEW = [
  'm01:view',
  'm02:view',
  'm03:view',
  'm04:view',
  'm05:view',
  'm06:view',
  'm07:view',
  'm08:view',
  'm09:view',
  'm10:view',
  'm11:view',
  'm12:view',
] as const;

export const ROLE_PERMISSIONS: Record<RoleCode, readonly Permission[]> = {
  // 老板：全局视野 + 关键审批 + 业务审计 + 敏感导出（审批制发起）
  // M01 查看 / M02 审批发布·预算 / M03 全局 / M04 查看 / M05 接管·决策 / M06 审批生效 /
  // M07 查看 / M08 查看 / M09 查看 / M10 全局含毛利·收支登记 / M11 审批变更 / M12 全局
  boss: [
    ...ALL_MODULE_VIEW,
    'm02:approve',
    'm03:edit',
    'm05:edit',
    'm06:approve',
    'm07:edit',
    'm11:approve',
    'm12:edit',
    'audit:view',
    'sensitive:export',
    'approval:view',
    'approval:request',
    'approval:decide',
    // AI 通道成本对 boss 属经营视野（PERMISSION_MATRIX.md AI通道成本行，2026-08-13 用户批准）
    'ai:cost:view',
    // 2026-08-26 老板批准：店长不在位时的工作稳定性——老板升级为业务全权备份
    // （原老板 ∪ 店长 ∪ 销售 ∪ 施工录入 m08:edit），技术特权（system:manage）仍不授
    'm01:edit',
    'm02:edit',
    'm06:edit',
    'm07:approve',
    'm08:edit',
    'm08:approve',
    'm09:edit',
    // 批次2（2026-09-02）：财务收支流水登记（append-only），老板与店长均持 m10:edit
    'm10:edit',
    'm11:edit',
  ],
  // 店长：运营执行 + 排期/质检确认 + 本店审计 + 敏感导出（审批制发起）
  // M02 审核(🔶) / M03 全局 / M05 接管执行·摘要 / M06 维护·生效 / M07 最终确认排期 /
  // M08 复检·交付确认 / M09 执行 / M12 执行；M10 收支登记（批次2）/ M11 仅查看（🔶 范围约束推迟）
  store_manager: [
    ...ALL_MODULE_VIEW,
    'm02:approve',
    'm03:edit',
    'm05:edit',
    'm06:edit',
    'm07:edit',
    'm07:approve',
    'm08:approve',
    'm09:edit',
    // 批次2（2026-09-02）：财务收支流水登记（append-only），店长负责本店收支记账
    'm10:edit',
    'm12:edit',
    'audit:view',
    'sensitive:export',
    'approval:view',
    'approval:request',
    'approval:decide',
  ],
  // 销售/运营：本人范围（🔶 数据范围 P3 落地）；无审计、无敏感导出、无系统配置
  // M01 查看/整理 / M02 制作·提交 / M03 本人负责+分配内(🔶) / M04 本人客户(🔶 仅查看+范围) /
  // M05 发起接管申请(🔶) / M06 检索使用(仅查看) / M07 发起预约(🔶) / M08 查看本人客户(🔶 范围) /
  // M09 回访执行 / M11 反馈(🔶) / M12 线索跟进(🔶)
  sales_ops: [
    ...ALL_MODULE_VIEW,
    'm01:edit',
    'm02:edit',
    'm03:edit',
    'm05:edit',
    'm07:edit',
    'm09:edit',
    'm11:edit',
    'm12:edit',
    'approval:view',
    'approval:request',
  ],
  // 施工记录员：施工录入（M08）+ 勘察录入（M12 🔶）+ 案例素材提交（M06 🔶，范围推迟）；
  // 其余业务模块一律禁止（技师不设账号，信息由店长或授权人员代录）
  recorder: ['m06:view', 'm06:edit', 'm08:view', 'm08:edit', 'm12:view', 'm12:edit'],
  // 系统管理员：技术权限 ≠ 业务数据使用权；业务模块一律禁止。
  // AI 通道成本属集成监控而非业务数据（矩阵 §1 系统管理员定位），为例外项
  sys_admin: [
    'system:manage',
    'audit:view',
    'sensitive:export',
    // PERMISSION_MATRIX.md AI通道成本行（2026-08-13 用户批准）
    'ai:cost:view',
  ],
};

/** 多角色权限并集（user_roles → 权限集合） */
export function permissionsOf(roles: readonly string[]): Set<Permission> {
  const set = new Set<Permission>();
  for (const code of roles) {
    if ((ROLE_CODES as readonly string[]).includes(code)) {
      for (const p of ROLE_PERMISSIONS[code as RoleCode]) set.add(p);
    }
  }
  return set;
}
