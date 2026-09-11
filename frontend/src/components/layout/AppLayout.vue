<script setup lang="ts">
/* global localStorage, document, window, MediaQueryList, MediaQueryListEvent */
// 工作台基础布局：左侧导航 + 顶栏 + 内容区（P0-03）
// 菜单项定义为数组（含 required 权限点），渲染前用 can() 过滤（P1-02）；
// 前端过滤只是体验（矩阵 §5），越权访问以后端守卫为准。
import { ElMessageBox } from 'element-plus';
import {
  Aim,
  Calendar,
  Collection,
  Cpu,
  DataAnalysis,
  DocumentChecked,
  Fold,
  FolderOpened,
  HomeFilled,
  Moon,
  Operation,
  Service,
  Setting,
  Sunny,
  SwitchButton,
  ChatDotRound,
  Wallet,
  Tickets,
  UserFilled,
  VideoCamera,
} from '@element-plus/icons-vue';
import type { Component } from 'vue';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { usePermission } from '../../composables/usePermission';
import { useAiStore } from '../../stores/ai';
import { useAuthStore } from '../../stores/auth';
import { applyTheme, getStoredTheme, type Theme } from '../../utils/theme';
import ChangePasswordDialog from './ChangePasswordDialog.vue';
import AgentChat from '../agent/AgentChat.vue';
import NotificationBell from '../notification/NotificationBell.vue';
import FeatureTour from './FeatureTour.vue';
import SidebarNav from './SidebarNav.vue';

interface MenuItem {
  index: string;
  title: string;
  icon: Component;
  group: '经营' | '客资' | '交付' | '系统';
  /** 所需权限点（单点或数组，数组任一命中即可见）；缺省 = 登录即可见 */
  required?: string | readonly string[];
}

// P1 菜单：首页 + 审批中心（审批中心路由/页面 Task 8 落地，此处预留结构）
// P2-09：AI 通道管理；2026-08-13 成本可见性调整为 system:manage 或 ai:cost:view 任一命中可见
const MENU_ITEMS: readonly MenuItem[] = [
  { index: '/', title: '首页', icon: HomeFilled, group: '经营' },
  {
    index: '/analytics',
    title: '经营复盘',
    icon: DataAnalysis,
    group: '经营',
    required: 'm10:view',
  },
  { index: '/finance', title: '财务收支', icon: Wallet, group: '经营', required: 'm10:view' },
  {
    index: '/marketing',
    title: '经营任务',
    icon: VideoCamera,
    group: '经营',
    required: 'm02:view',
  },
  {
    index: '/approvals',
    title: '审批中心',
    icon: DocumentChecked,
    group: '经营',
    required: 'approval:view',
  },
  { index: '/leads', title: '客资队列', icon: Tickets, group: '客资', required: 'm03:view' },
  { index: '/roleplay', title: '销售陪练', icon: ChatDotRound, group: '客资' },
  {
    index: '/leads/import',
    title: '客资导入',
    icon: FolderOpened,
    group: '客资',
    required: 'm03:edit',
  },
  { index: '/takeover', title: '接管队列', icon: Aim, group: '客资', required: 'm05:view' },
  { index: '/knowledge', title: '知识库', icon: Collection, group: '客资', required: 'm06:view' },
  // V2.3b：素材库（M06 报价图/产品资料/施工过程/完工案例），权限口径同知识库
  { index: '/assets', title: '素材库', icon: Collection, group: '客资', required: 'm06:view' },
  // P5：预约与排期（M07）、施工单（M08）；施工记录员无 m07:view，菜单自动隐藏
  {
    index: '/appointments',
    title: '预约与排期',
    icon: Calendar,
    group: '交付',
    required: 'm07:view',
  },
  { index: '/work-orders', title: '施工单', icon: Operation, group: '交付', required: 'm08:view' },
  // M09 批次1：售后与回访（回访/受理/质保登记/转介绍），交付组施工单之后
  { index: '/aftercare', title: '售后与回访', icon: Service, group: '交付', required: 'm09:view' },
  // V2.4：人机团队（M08 技师/Agent 花名册/考勤奖惩），权限口径同施工单
  { index: '/team', title: '人机团队', icon: UserFilled, group: '交付', required: 'm08:view' },
  {
    index: '/ai-settings',
    title: 'AI 通道管理',
    icon: Cpu,
    group: '系统',
    required: ['system:manage', 'ai:cost:view'],
  },
  // V2.2b：Agent 任务控制台（AI 通道管理旁），权限口径同 AI 通道成本行
  {
    index: '/ai-tasks',
    title: 'AI 任务',
    icon: Operation,
    group: '系统',
    required: ['ai:cost:view', 'system:manage'],
  },
];

const MENU_GROUPS: readonly MenuItem['group'][] = ['经营', '客资', '交付', '系统'];

const route = useRoute();
const { can } = usePermission();
/** 详情页属于客资队列，保持左侧菜单高亮；导入页则单独高亮客资导入。 */
const activeMenu = computed(() => {
  if (route.path.startsWith('/leads/import')) return '/leads/import';
  if (route.path.startsWith('/leads/')) return '/leads';
  return route.path;
});
const visibleMenus = computed(() =>
  MENU_ITEMS.filter((m) => {
    if (!m.required) return true;
    if (typeof m.required === 'string') return can(m.required);
    return m.required.some((perm) => can(perm)); // 数组：任一命中即可见
  }),
);
const visibleMenuGroups = computed(() =>
  MENU_GROUPS.map((group) => ({
    group,
    items: visibleMenus.value.filter((item) => item.group === group),
  })).filter((section) => section.items.length > 0),
);

// AI 通道状态轮询（P2-09）：布局挂载启动、卸载停止；横幅由 store.notice 驱动，全路由可见
const ai = useAiStore();
onMounted(() => ai.startPolling());
onUnmounted(() => ai.stopPolling());

// 顶栏账号区（V2.6 布局修复）：右侧显示当前用户 + 退出入口；
// 确认后仅清会话并回登录页，不弹多余 toast（与 http 拦截器的静默清理口径一致）。
const router = useRouter();

// AI 助手对话抽屉（2026-08-26 销售 Agent V1）：顶栏常驻入口
const agentVisible = ref(false);
const auth = useAuthStore();

const onLogout = async () => {
  // 未保存内容提醒（2026-08-28 UI 测试 #12）：预约等对话框填了一半点退出，确认框直接
  // 叠在表单上无任何提示——检测到有弹窗打开时确认文案带「内容将丢失」警告
  const hasOpenDialog = Boolean(
    document.querySelector('.el-overlay:not([style*="display: none"])'),
  );
  const confirmed = await ElMessageBox.confirm(
    hasOpenDialog
      ? '当前有窗口正填写到一半，退出后未保存的内容将丢失。确定退出当前账号？'
      : '确定退出当前账号？',
    '',
    {
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      showClose: false,
      distinguishCancelAndClose: true,
      type: hasOpenDialog ? 'warning' : undefined,
    },
  ).then(
    () => true,
    () => false,
  );
  if (!confirmed) return;
  auth.logout();
  router.replace('/login');
};

// 自行改密（任务书 #11）：顶栏齿轮唤起对话框；改密成功后保持登录态（后端不作废令牌）
const changePasswordVisible = ref(false);
// ─── 移动端导航抽屉（2026-09-02 门店实况：员工走动办公用手机，固定侧栏占掉半屏）───
// ≤768px 时左侧栏收进抽屉，顶栏汉堡按钮唤起；断点监听而非一次性判定，转屏/缩放即时切换
const navDrawerVisible = ref(false);
const isMobile = ref(false);
let mobileQuery: MediaQueryList | null = null;
const onMobileChange = (e: MediaQueryListEvent): void => {
  isMobile.value = e.matches;
  if (!e.matches) navDrawerVisible.value = false; // 回桌面尺寸即收抽屉
};
onMounted(() => {
  mobileQuery = window.matchMedia('(max-width: 768px)');
  isMobile.value = mobileQuery.matches;
  mobileQuery.addEventListener('change', onMobileChange);
});
onUnmounted(() => {
  mobileQuery?.removeEventListener('change', onMobileChange);
  mobileQuery = null;
});
// 路由切换时强制收起改密弹窗（2026-08-22 修复：旧 DOM 未销毁时切页会"莫名弹出"）；
// 移动端抽屉同步收起（手机上选完菜单直接看内容）
watch(
  () => route.path,
  () => {
    changePasswordVisible.value = false;
    navDrawerVisible.value = false;
  },
);

// ─── 主题（2026-08-21 品牌化）：深/浅色切换，偏好持久化 ───
const theme = ref<Theme>(getStoredTheme());
function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  applyTheme(theme.value);
}

// ─── 功能讲解小贴士：首次登录自动出现（wg.tipsDone 未置位），顶栏「?」可重看 ───
const tipsVisible = ref(localStorage.getItem('wg.tipsDone') !== '1');
</script>

<template>
  <el-container class="app-layout">
    <el-aside width="200px" class="app-layout__aside">
      <SidebarNav :groups="visibleMenuGroups" :active-menu="activeMenu" />
    </el-aside>
    <el-container>
      <el-header class="app-layout__header" height="48px">
        <div class="app-layout__header-lead">
          <!-- 汉堡按钮（仅手机显示）：唤起导航抽屉 -->
          <el-button
            class="app-layout__menu-toggle"
            :icon="Fold"
            aria-label="打开菜单"
            data-test="nav-toggle"
            @click="navDrawerVisible = true"
          />
          <span class="app-layout__title">AutoFilm Ops · AI经营协同系统</span>
          <span class="app-layout__title-mobile">AutoFilm Demo</span>
        </div>
        <div class="app-layout__user">
          <!-- 通知铃铛（2026-09-02 移至顶栏）：桌面原在品牌行，手机上抽屉深处不可达 -->
          <NotificationBell />
          <span class="app-layout__username">{{ auth.user?.displayName }}</span>
          <!-- 主题切换（2026-08-21）：日月按钮，深/浅色即时生效并记忆 -->
          <el-button
            size="small"
            round
            :icon="theme === 'dark' ? Sunny : Moon"
            :aria-label="theme === 'dark' ? '切换为浅色模式' : '切换为深色模式'"
            data-test="theme-toggle"
            @click="toggleTheme"
          />
          <!-- 功能讲解小贴士重看入口 -->
          <el-button
            size="small"
            round
            aria-label="功能小贴士"
            data-test="tips-entry"
            @click="tipsVisible = true"
          >
            ?
          </el-button>
          <!-- 自行改密入口（#11）：齿轮设置按钮，退出按钮旁 -->
          <el-button
            class="app-layout__settings"
            size="small"
            round
            :icon="Setting"
            aria-label="修改密码"
            data-test="change-password-entry"
            @click="changePasswordVisible = true"
          />
          <el-button
            class="app-layout__logout"
            size="small"
            round
            :icon="isMobile ? SwitchButton : undefined"
            :aria-label="isMobile ? '退出登录' : undefined"
            data-test="logout"
            @click="onLogout"
            >{{ isMobile ? '' : '退出登录' }}</el-button
          >
        </div>
      </el-header>
      <!-- AI 降级横幅（P2-09，规格 §8）：不可关闭，文案由 store 固定为「AI 暂不可用，请人工处理」 -->
      <el-alert
        v-if="ai.notice"
        :title="ai.notice"
        type="warning"
        :closable="false"
        show-icon
        class="ai-degraded-banner"
      />
      <el-main class="app-layout__main"><router-view /></el-main>
    </el-container>
    <!-- 移动端导航抽屉（2026-09-02）：与桌面侧栏同一份 SidebarNav，菜单点击跳转后自动收起 -->
    <el-drawer
      v-if="isMobile"
      v-model="navDrawerVisible"
      direction="ltr"
      size="264px"
      :with-header="false"
      class="app-layout__nav-drawer"
    >
      <SidebarNav :groups="visibleMenuGroups" :active-menu="activeMenu" />
    </el-drawer>
    <!-- 自行改密对话框（#11）：齿轮入口唤起，成功后仍保持当前登录态 -->
    <ChangePasswordDialog v-model:visible="changePasswordVisible" />
    <!-- 功能讲解小贴士：首次登录出现，可跳过/重看 -->
    <FeatureTour v-model:visible="tipsVisible" />
    <!-- AI 助手对话抽屉（2026-08-26）：全角色可开，人格后端按角色装载 -->
    <!-- 悬浮 AI 助手入口（2026-08-26 老板设计）：金色 V 浮球常驻右下角跟随页面，
         不再占顶栏/品牌行空间（原品牌行入口挤压标题排版） -->
    <button
      type="button"
      class="app-layout__agent-fab"
      aria-label="AI 助手"
      title="AI 助手（话术/文案/口径速查）"
      data-testid="agent-entry"
      @click="agentVisible = true"
    >
      <span class="app-layout__agent-fab-v">A</span>
    </button>
    <AgentChat v-model="agentVisible" />
  </el-container>
</template>

<style scoped>
.app-layout {
  position: relative;
  height: 100vh;
  isolation: isolate;
  background-color: var(--wg-canvas);
}
.app-layout::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  opacity: 0.42;
  background-image:
    linear-gradient(rgba(96, 79, 48, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(96, 79, 48, 0.045) 1px, transparent 1px);
  background-size: 44px 44px;
  pointer-events: none;
}
.app-layout > .el-aside,
.app-layout > .el-container {
  position: relative;
  z-index: 1;
}
/* 侧栏纵向撑满（内容/滚动由 SidebarNav 自管）：桌面常驻左栏，手机由媒体查询隐藏 */
.app-layout__aside {
  border-right: 1px solid var(--el-border-color);
  background: var(--wg-surface);
  box-shadow: 8px 0 28px rgba(18, 26, 38, 0.035);
}
/* 悬浮 AI 助手浮球（2026-08-26 老板设计）：金色 V 常驻右下角、固定定位跟随页面；
   z-index 低于抽屉遮罩（el-drawer ~2000+），抽屉打开时被遮罩盖住不干扰 */
.app-layout__agent-fab {
  position: fixed;
  right: 28px;
  bottom: 32px;
  width: 54px;
  height: 54px;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--brand-gold, #d4af37), #b8860b);
  box-shadow:
    0 4px 14px color-mix(in srgb, var(--brand-gold, #d4af37) 45%, transparent),
    0 2px 4px rgb(0 0 0 / 18%);
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
  z-index: 1600;
}
.app-layout__agent-fab:hover,
.app-layout__agent-fab:focus-visible {
  transform: scale(1.08);
  box-shadow:
    0 6px 20px color-mix(in srgb, var(--brand-gold, #d4af37) 60%, transparent),
    0 3px 6px rgb(0 0 0 / 22%);
}
.app-layout__agent-fab-v {
  font-size: 24px;
  font-weight: 800;
  line-height: 1;
  color: #fff;
  text-shadow: 0 1px 2px rgb(0 0 0 / 25%);
}
.app-layout__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 24px;
  border-bottom: 1px solid var(--wg-hairline);
  background: color-mix(in srgb, var(--wg-surface) 92%, transparent);
  backdrop-filter: blur(12px);
}
/* 顶栏左段：汉堡（手机）+ 标题 */
.app-layout__header-lead {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.app-layout__menu-toggle {
  display: none; /* 仅手机媒体查询内显示 */
}
/* 左侧系统名：次要色小字（Apple 令牌，不做大标题）；手机换短品牌名 */
.app-layout__title {
  font-size: 13px;
  color: var(--wg-ink-muted);
  white-space: nowrap;
}
.app-layout__title-mobile {
  display: none; /* 仅手机媒体查询内显示 */
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--wg-ink);
  white-space: nowrap;
  flex-shrink: 0; /* 顶栏空间不足时宁可挤右侧间距，不折行成竖排碎片 */
}
.app-layout__user {
  display: flex;
  align-items: center;
  gap: 12px;
}
.app-layout__username {
  font-size: 14px;
  color: var(--wg-ink);
}
/* 内容区统一 24px 留白（V2.6 布局修复）：页面不再自带 padding，避免双重留白 */
.app-layout__main {
  padding: 24px;
  background: transparent;
}
.ai-degraded-banner {
  margin: 8px 8px 0;
}

/* ─── 移动端（≤768px，2026-09-02 门店实况：员工走动办公用手机）───
 * 侧栏收抽屉（模板内 el-drawer）；顶栏只留汉堡+短品牌名+铃铛/主题/改密/退出（图标）；
 * 内容留白 24→12px 让表格与卡片多吃一列；浮球离屏幕边缘更近防误触系统手势 */
@media (max-width: 768px) {
  .app-layout__aside {
    display: none;
  }
  .app-layout__menu-toggle {
    display: inline-flex;
  }
  .app-layout__title {
    display: none;
  }
  .app-layout__title-mobile {
    display: inline;
  }
  .app-layout__username {
    display: none; /* 顶栏空间有限；账号名在改密弹窗/登录页仍可见 */
  }
  /* 小贴士重看入口手机隐藏：低频且顶栏放不下（首次引导仍会自动出现） */
  .app-layout__user :deep([data-test='tips-entry']) {
    display: none;
  }
  .app-layout__header {
    padding: 0 12px;
  }
  .app-layout__user {
    gap: 8px;
  }
  /* 触摸目标：EP small 按钮 24px 偏小，手机端顶栏按钮统一加高到 32px */
  .app-layout__user :deep(.el-button) {
    height: 32px;
  }
  .app-layout__user :deep(.el-button + .el-button) {
    margin-left: 0;
  }
  /* 手机端退出按钮缩为图标（template 内 :icon 切换），补触摸目标尺寸 */
  .app-layout__logout :deep(.el-icon) {
    font-size: 16px;
  }
  .app-layout__main {
    padding: 12px;
  }
  .app-layout__agent-fab {
    right: 16px;
    bottom: 20px;
    width: 50px;
    height: 50px;
  }
  .app-layout__agent-fab-v {
    font-size: 22px;
  }
}
</style>
