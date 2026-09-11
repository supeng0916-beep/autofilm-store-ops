<script setup lang="ts">
// 首页控制面板（V2.0）：真实数据看板 + 今日待办。（2026-08-26 店内助手卡片下线；2026-08-28 常用任务区下线——入口均在侧栏直达，首页聚焦指标与待办）
// 数据源 GET /analytics/dashboard（老板/店长全局，销售/记录员按本人相关）；
// 样式按 DESIGN-apple 令牌（浅色画布/白卡 hairline/单一 #0066cc）。
// V2.6 布局修复：去掉 1280 阅读宽度与页面自带 padding，占满 el-main 内容区。
import {
  AlarmClock,
  Calendar,
  Tickets,
  TrendCharts,
  UploadFilled,
  User,
} from '@element-plus/icons-vue';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { analyticsApi } from '../api/analytics';
import { usePermission } from '../composables/usePermission';

interface DashboardTodo {
  kind: 'sla' | 'approval' | 'follow_up' | 'recheck';
  title: string;
  meta: string;
  link: string;
}

interface DashboardData {
  greetingName: string;
  metrics: {
    todayNewLeads: number;
    slaDue: number;
    pendingApprovals: number;
    todayAppointments: number;
    monthRevenueFen: number;
    monthWonCount: number;
  };
  todos: DashboardTodo[];
  scopedToOwner: boolean;
}

const router = useRouter();
const { can } = usePermission();
const data = ref<DashboardData | null>(null);
const loading = ref(false);

const load = async () => {
  loading.value = true;
  try {
    data.value = await analyticsApi.dashboard();
  } catch {
    // 后端不可达/未登录失效时保持空态（全局拦截器已提示错误，此处不重复弹窗）
    data.value = null;
  } finally {
    loading.value = false;
  }
};

const fen = (v: number) => `¥${(v / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
const today = new Date().toLocaleDateString('zh-CN', {
  month: 'long',
  day: 'numeric',
  weekday: 'long',
});

const KIND_LABEL: Record<DashboardTodo['kind'], string> = {
  sla: 'SLA',
  approval: '审批',
  follow_up: '跟进',
  recheck: '施工',
};
const KIND_CLASS: Record<DashboardTodo['kind'], string> = {
  sla: 'danger',
  approval: 'info',
  follow_up: '',
  recheck: 'success',
};

onMounted(load);
</script>

<template>
  <div v-loading="loading" class="home">
    <div class="hero">
      <div class="hero__copy">
        <span class="hero__eyebrow">门店经营总览</span>
        <h1>你好，{{ data?.greetingName ?? '…' }}</h1>
        <div class="hero-sub">
          {{ today }}
          <template v-if="data">
            ｜ 今日 {{ data.metrics.todayNewLeads }} 条新客资
            <template v-if="data.metrics.slaDue > 0">
              ｜ <span class="hero-alert">{{ data.metrics.slaDue }} 条 SLA 到期待触达</span>
            </template>
            <template v-if="data.metrics.pendingApprovals > 0">
              ｜ {{ data.metrics.pendingApprovals }} 笔审批等你
            </template>
          </template>
          <el-tag v-if="data?.scopedToOwner" size="small" type="info" style="margin-left: 8px">
            本人范围
          </el-tag>
        </div>
      </div>
      <div class="hero__actions">
        <el-button
          v-if="can('m07:edit')"
          type="primary"
          :icon="Calendar"
          @click="router.push('/appointments')"
          >发起预约</el-button
        >
        <el-button v-if="can('m03:edit')" :icon="UploadFilled" @click="router.push('/leads/import')"
          >导入客资</el-button
        >
      </div>
    </div>

    <template v-if="data">
      <!-- 关键指标 -->
      <div class="metrics">
        <div class="wg-card metric">
          <el-icon class="metric__icon"><User /></el-icon>
          <div class="wg-num">{{ data.metrics.todayNewLeads }}</div>
          <div class="wg-muted">今日新增客资</div>
        </div>
        <div class="wg-card metric" :class="{ alert: data.metrics.slaDue > 0 }">
          <el-icon class="metric__icon"><AlarmClock /></el-icon>
          <div class="wg-num" :class="{ 'num-alert': data.metrics.slaDue > 0 }">
            {{ data.metrics.slaDue }}
          </div>
          <div class="wg-muted">SLA 到期待触达</div>
        </div>
        <div class="wg-card metric">
          <el-icon class="metric__icon"><Tickets /></el-icon>
          <div class="wg-num">{{ data.metrics.pendingApprovals }}</div>
          <div class="wg-muted">待我审批</div>
        </div>
        <div class="wg-card metric">
          <el-icon class="metric__icon"><Calendar /></el-icon>
          <div class="wg-num">{{ data.metrics.todayAppointments }}</div>
          <div class="wg-muted">今日预约到店</div>
        </div>
        <div class="wg-card metric">
          <el-icon class="metric__icon"><TrendCharts /></el-icon>
          <div class="wg-num">{{ fen(data.metrics.monthRevenueFen) }}</div>
          <div class="wg-muted">本月成交额（{{ data.metrics.monthWonCount }} 单）</div>
        </div>
      </div>

      <div class="grid">
        <!-- 今日待办 -->
        <div class="wg-card">
          <h2 class="wg-card-title">
            今日待办<span class="wg-muted" style="margin-left: 8px"
              >{{ data.todos.length }} 项</span
            >
          </h2>
          <div v-for="(t, i) in data.todos" :key="i" class="todo">
            <span class="wg-tag" :class="KIND_CLASS[t.kind]">{{ KIND_LABEL[t.kind] }}</span>
            <span class="todo-txt"
              >{{ t.title }}<span class="todo-meta">{{ t.meta }}</span></span
            >
            <el-button link type="primary" @click="router.push(t.link)">去处理</el-button>
          </div>
          <el-empty v-if="data.todos.length === 0" description="暂无待办" :image-size="60" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.home {
  width: 100%;
}
.hero {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 20px;
  padding: 4px 2px 20px;
  border-bottom: 1px solid var(--wg-divider-soft);
}
.hero__eyebrow {
  display: block;
  margin-bottom: 6px;
  color: var(--wg-primary);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0;
}
.hero__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.hero h1 {
  margin: 0;
  font-size: 32px;
  font-weight: 600;
  letter-spacing: 0;
  color: var(--wg-ink);
}
.hero-sub {
  color: var(--wg-ink-muted);
  font-size: 14px;
  margin-top: 4px;
}
.hero-alert {
  color: var(--wg-danger);
}
.metrics {
  display: grid;
  /* V2.6 布局修复：auto-fit 自适应列数，1280 宽窗口不溢出 */
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}
.metric {
  position: relative;
  min-height: 104px;
  padding: 20px;
  overflow: hidden;
  border-radius: 12px;
  transition:
    border-color 180ms cubic-bezier(0.23, 1, 0.32, 1),
    box-shadow 180ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
}
.metric:hover {
  border-color: color-mix(in srgb, var(--wg-primary) 30%, var(--wg-hairline));
  box-shadow: 0 8px 20px rgba(18, 26, 38, 0.07);
  transform: translateY(-2px);
}
.metric.alert {
  border-color: color-mix(in srgb, var(--wg-danger) 36%, var(--wg-hairline));
}
.metric__icon {
  position: absolute;
  top: 18px;
  right: 18px;
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 1px solid var(--wg-divider-soft);
  border-radius: 8px;
  color: var(--wg-ink-muted);
  background: var(--wg-canvas);
}
.metric.alert .metric__icon {
  color: var(--wg-danger);
  border-color: color-mix(in srgb, var(--wg-danger) 18%, var(--wg-divider-soft));
}
.num-alert {
  color: var(--wg-danger);
}
.grid {
  display: grid;
  /* 2026-08-26 店内助手卡片下线：今日待办拉通整行（老板反馈右列空置浪费屏宽） */
  grid-template-columns: 1fr;
  gap: 16px;
  align-items: stretch;
}
.todo {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid var(--wg-divider-soft);
}
.todo:first-of-type {
  border-top: none;
}
.todo-txt {
  flex: 1;
  font-size: 14px;
  color: var(--wg-ink);
}
.todo-meta {
  display: block;
  font-size: 12px;
  color: var(--wg-ink-muted);
}
@media (max-width: 768px) {
  .hero {
    align-items: flex-start;
    flex-direction: column;
    gap: 16px;
  }
  .hero__actions {
    justify-content: flex-start;
  }
  .grid {
    grid-template-columns: 1fr;
  }
}
@media (prefers-reduced-motion: reduce) {
  .metric,
  .metric:hover {
    transition: none;
  }
}
</style>
