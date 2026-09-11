import { getActivePinia } from 'pinia';

import { useAuthStore } from '../stores/auth';

/** 视图层权限判断：仅控制渲染（安全边界在后端，矩阵 §5） */
export function usePermission() {
  // 无活跃 Pinia（隔离组件单测未安装）时降级为全 false 保持可渲染；
  // 生产路由挂载前必装 Pinia——装了仍初始化失败属真异常，不再吞掉（2026-08-26 审查 #7，
  // 此前 try/catch 会把 store 故障吞成全站菜单按钮无声消失）
  if (!getActivePinia()) return { can: (): boolean => false };
  const auth = useAuthStore();
  return { can: (perm: string): boolean => auth.has(perm) };
}
