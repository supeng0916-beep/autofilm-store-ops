import { createRouter, createWebHistory } from 'vue-router';

import { useAuthStore } from '../stores/auth';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('../views/LoginView.vue') },
    // 登录过渡页（2026-08-21 品牌化）：欢迎语 ≥2s 后进工作台（需已登录，守卫自然覆盖）
    {
      path: '/welcome',
      name: 'welcome',
      component: () => import('../views/SplashView.vue'),
    },
    {
      path: '/',
      component: () => import('../components/layout/AppLayout.vue'),
      children: [
        { path: '', name: 'home', component: () => import('../views/HomeView.vue') },
        // 审批中心（P1-05）：懒加载；菜单可见性由 AppLayout 按 approval:view 过滤，
        // 数据访问以后端守卫为准（前端过滤仅为体验）
        {
          path: 'approvals',
          name: 'approvals',
          component: () => import('../views/ApprovalCenterView.vue'),
        },
        // AI 通道管理（P2-09）：meta.permission 由前置守卫拦截（数组任一命中放行，全无则回首页），
        // 菜单可见性由 AppLayout 同点位过滤；开关读写/成本查看以后端守卫为准。
        // 2026-08-13 成本可见性调整：ai:cost:view（boss/sys_admin）可见成本段，system:manage 管开关
        {
          path: 'ai-settings',
          name: 'ai-settings',
          component: () => import('../views/AiSettingsView.vue'),
          meta: { permission: ['system:manage', 'ai:cost:view'], title: 'AI 通道管理' },
        },
        // Agent 任务控制台（V2.2b）：ai:cost:view ∪ system:manage 任一命中放行（同 AI 通道成本行口径）；
        // 列表/详情/重试/接管以后端守卫为准（sales/recorder 403），前端门禁仅为体验
        {
          path: 'ai-tasks',
          name: 'ai-tasks',
          component: () => import('../views/AiTasksView.vue'),
          meta: { permission: ['ai:cost:view', 'system:manage'], title: 'AI 任务' },
        },
        // 客资导入（P3-01）：meta.permission 单点 'm03:edit' 由前置守卫拦截；
        // 菜单可见性由 AppLayout 同点位过滤，数据访问以后端守卫为准
        {
          path: 'leads/import',
          name: 'lead-import',
          component: () => import('../views/LeadImportView.vue'),
          meta: { permission: 'm03:edit', title: '客资导入' },
        },
        // 客资队列（P3-03）：meta.permission 单点 'm03:view' 由前置守卫拦截；
        // 菜单可见性由 AppLayout 同点位过滤；详情入口（/leads/:id）由 Task 9 落地。
        // 销售陪练（V1.5 批次6a）：全员共用练功房——AI 演客户、员工练回答、结束点评；
        // 登录即可（无权限点，同 AI 助手入口）
        {
          path: 'roleplay',
          name: 'roleplay',
          component: () => import('../views/RoleplayView.vue'),
          meta: { title: '销售陪练' },
        },
        {
          path: 'leads',
          name: 'leads',
          component: () => import('../views/LeadsQueueView.vue'),
          meta: { permission: 'm03:view', title: '客资队列' },
        },
        // 客资详情（P3-06）：三栏——客资字段卡＋SLA／时间线／AI 摘要＋草稿工作区。
        // meta.permission 单点 'm03:view' 由前置守卫拦截；草稿/阶段写动作在后端另按 m03:edit 校验
        {
          path: 'leads/:id',
          name: 'lead-detail',
          component: () => import('../views/LeadDetailView.vue'),
          meta: { permission: 'm03:view', title: '客资详情' },
        },
        // 知识库管理（P4-04）：meta.permission 单点 'm06:view' 由前置守卫拦截；
        // 编辑/生效操作在后端另按 m06:edit 校验
        {
          path: 'knowledge',
          name: 'knowledge',
          component: () => import('../views/KnowledgeManageView.vue'),
          meta: { permission: 'm06:view', title: '知识库' },
        },
        // 素材库（V2.3b，M06）：'m06:view' 拦截；上传在后端另按 m06:edit ∪ m06:approve 校验
        {
          path: 'assets',
          name: 'assets',
          component: () => import('../views/AssetsView.vue'),
          meta: { permission: 'm06:view', title: '素材库' },
        },
        // 接管队列（P4-05）：meta.permission 单点 'm05:view' 由前置守卫拦截
        {
          path: 'takeover',
          name: 'takeover',
          component: () => import('../views/TakeoverQueueView.vue'),
          meta: { permission: 'm05:view', title: '接管队列' },
        },
        // 预约与排期（P5-01~03）：'m07:view' 拦截；发起/取消/替换在后端另按 m07:edit 校验
        {
          path: 'appointments',
          name: 'appointments',
          component: () => import('../views/AppointmentsView.vue'),
          meta: { permission: 'm07:view', title: '预约与排期' },
        },
        // 施工单（P5-04~06）：'m08:view' 拦截（销售限本人客资，后端过滤）；
        // 录入/自检按 m08:edit、复检/交付按 m08:approve 后端校验
        {
          path: 'work-orders',
          name: 'work-orders',
          component: () => import('../views/WorkOrdersView.vue'),
          meta: { permission: 'm08:view', title: '施工单' },
        },
        // 售后与回访（M09 批次1）：'m09:view' 拦截；回访/受理/质保登记/转介绍写操作后端另按 m09:edit 校验
        {
          path: 'aftercare',
          name: 'aftercare',
          component: () => import('../views/AftercareView.vue'),
          meta: { permission: 'm09:view', title: '售后与回访' },
        },
        // 财务收支（批次2 T6，M10）：手工流水台账；'m10:view' 拦截，登记按钮 m10:edit（后端守卫为准）
        {
          path: 'finance',
          name: 'finance',
          component: () => import('../views/FinanceView.vue'),
          meta: { permission: 'm10:view', title: '财务收支' },
        },
        // 人机团队（V2.4，M08）：技师/Agent 花名册/考勤奖惩一页总览；'m08:view' 拦截（同施工单口径）；
        // 写操作后端按 boss|store_manager 角色硬校验，前端按钮显隐近似 approval:decide（体验层）
        {
          path: 'team',
          name: 'team',
          component: () => import('../views/TeamView.vue'),
          meta: { permission: 'm08:view', title: '人机团队' },
        },
        // 经营任务中心（V2.1 首批，M02）：短视频文案/同行整理；m02:edit 操作，m02:view 可见
        {
          path: 'marketing',
          name: 'marketing',
          component: () => import('../views/MarketingView.vue'),
          meta: { permission: 'm02:view', title: '经营任务' },
        },
        // 经营复盘（M10 最小版）：'m10:view' 拦截；老板/店长全局，销售本人范围（后端过滤）
        {
          path: 'analytics',
          name: 'analytics',
          component: () => import('../views/AnalyticsView.vue'),
          meta: { permission: 'm10:view', title: '经营复盘' },
        },
      ],
    },
    // 404 兜底：未匹配路由统一落到 NotFoundView（P1 收尾项）
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('../views/NotFoundView.vue'),
    },
  ],
});

// 全局前置守卫：未登录一律跳 login；已登录访问 login 回首页。
// pinia 在 main.ts 先于 router 安装，守卫首次执行（mount 触发首次导航）时 useAuthStore 可用。
// 会话水合：页面刷新后 token 从 localStorage 恢复但 user/permissions 为空，
// 已登录而 user 未加载时先调 /auth/me 水合；失败（令牌失效/账号异常）则清登录态回登录页。
router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (to.name !== 'login' && !auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.name === 'login' && auth.isLoggedIn) {
    return { name: 'home' };
  }
  if (auth.isLoggedIn && !auth.user) {
    try {
      await auth.fetchMe();
    } catch {
      auth.logout();
      return { name: 'login', query: { redirect: to.fullPath } };
    }
  }
  // 页面权限门禁（P2-09）：路由 meta.permission 声明所需权限点，缺失时回首页。
  // 支持单点（string）与数组（readonly string[]，任一命中即放行）两种声明。
  // 置于会话水合之后，保证 permissions 已加载；前端门禁仅为体验（矩阵 §5），安全边界在后端。
  const requiredPermission = to.meta.permission as string | readonly string[] | undefined;
  if (typeof requiredPermission === 'string' && !auth.has(requiredPermission)) {
    return { name: 'home' };
  }
  if (Array.isArray(requiredPermission) && !requiredPermission.some((perm) => auth.has(perm))) {
    return { name: 'home' };
  }
  return true;
});

export default router;
