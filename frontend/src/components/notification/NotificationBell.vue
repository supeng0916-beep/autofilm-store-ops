<script setup lang="ts">
/* global setInterval, clearInterval */
// 通知铃铛与抽屉（V2.2a Task5）：el-badge 未读数 + el-drawer 通知列表。
// 60s 轮询 + 路由切换即时刷新角标；点击条目→标已读（尽力而为）+跳转 link；底部全部已读。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { notificationApi, type AppNotification } from '../../api/notification';

/** kind 中文标签：未知 kind 回退原值（后端新增类型不至空白） */
const KIND_LABELS: Record<string, string> = {
  approval_pending: '审批待办',
  approval_decided: '审批结果',
  appointment_confirmed: '排期确认',
  'system.backup': '系统备份',
  'competitor.daily': '同行动态',
};

const POLL_MS = 60_000;

const route = useRoute();
const router = useRouter();

const unread = ref(0);
const drawerOpen = ref(false);
const list = ref<AppNotification[]>([]);
const loading = ref(false);

const kindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind;
const fmtTime = (iso: string): string => new Date(iso).toLocaleString();

/** 角标刷新失败静默保留上次值（轮询常态，错误提示由 http 拦截器统一弹出） */
async function refreshCount(): Promise<void> {
  try {
    unread.value = await notificationApi.unreadCount();
  } catch {
    // 静默：不因角标失败打扰操作
  }
}

/** 打开抽屉即拉全量列表（已读+未读，前端区分样式） */
async function openDrawer(): Promise<void> {
  drawerOpen.value = true;
  loading.value = true;
  try {
    list.value = await notificationApi.list();
  } catch {
    list.value = [];
  } finally {
    loading.value = false;
  }
}

/** 点击条目：未读先标已读（失败不阻断），有 link 则跳转并收起抽屉 */
async function onItemTap(n: AppNotification): Promise<void> {
  if (!n.readAt) {
    try {
      await notificationApi.markRead(n.id);
      n.readAt = new Date().toISOString();
      unread.value = Math.max(0, unread.value - 1);
    } catch {
      // 已读标记失败不阻断跳转
    }
  }
  if (n.link) {
    drawerOpen.value = false;
    await router.push(n.link);
  }
}

/** 正文截断展示（2026-08-28 Q2：日报类长文不挤右侧抽屉），全文走居中详情弹窗 */
const BODY_ELLIPSIZE = 60;
function bodyPreview(n: AppNotification): string {
  const t = n.body ?? '';
  return t.length > BODY_ELLIPSIZE ? `${t.slice(0, BODY_ELLIPSIZE)}…` : t;
}
const detail = ref<AppNotification | null>(null);
/** 点「详情」：居中弹窗展示全文，同时按查看语义标已读 */
async function openDetail(n: AppNotification): Promise<void> {
  detail.value = n;
  if (!n.readAt) {
    try {
      await notificationApi.markRead(n.id);
      n.readAt = new Date().toISOString();
      unread.value = Math.max(0, unread.value - 1);
    } catch {
      // 已读标记失败不阻断展示
    }
  }
}

/** 全部已读：成功后本地同步置读，失败保持现状 */
async function onMarkAll(): Promise<void> {
  try {
    await notificationApi.markAllRead();
    list.value = list.value.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() }));
    unread.value = 0;
  } catch {
    // 失败保持现状
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  void refreshCount();
  timer = setInterval(() => void refreshCount(), POLL_MS);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  timer = null;
});

// 路由切换即时刷新：页面动作（审批决定/建预约）返回列表页时角标尽快到位
watch(
  () => route.path,
  () => void refreshCount(),
);
</script>

<template>
  <el-badge :value="unread" :hidden="unread === 0" :max="99" class="notification-bell">
    <el-button text aria-label="通知" data-test="notification-bell" @click="openDrawer">
      通知
    </el-button>
  </el-badge>

  <el-drawer
    v-model="drawerOpen"
    title="通知"
    size="360px"
    append-to-body
    class="notification-drawer"
  >
    <div v-loading="loading" class="notification-list">
      <el-empty v-if="!loading && list.length === 0" description="暂无通知" />
      <div
        v-for="n in list"
        :key="n.id"
        class="notification-item"
        :class="{ 'is-unread': !n.readAt }"
        role="button"
        :data-test="`notification-item-${n.id}`"
        @click="onItemTap(n)"
      >
        <div class="notification-item__head">
          <el-tag size="small" type="info">{{ kindLabel(n.kind) }}</el-tag>
          <span class="notification-item__time">{{ fmtTime(n.createdAt) }}</span>
        </div>
        <div class="notification-item__title">{{ n.title }}</div>
        <div v-if="n.body" class="notification-item__body">
          {{ bodyPreview(n) }}
          <el-button
            v-if="(n.body ?? '').length > BODY_ELLIPSIZE"
            size="small"
            text
            type="primary"
            class="notification-item__detail"
            data-testid="notification-detail"
            @click.stop="openDetail(n)"
            >详情</el-button
          >
        </div>
      </div>
    </div>
    <template #footer>
      <el-button data-test="mark-all" :disabled="unread === 0" @click="onMarkAll">
        全部已读
      </el-button>
    </template>
  </el-drawer>

  <!-- 通知详情（Q2）：居中弹窗展示全文，长文不再挤抽屉 -->
  <el-dialog
    :model-value="detail !== null"
    :title="detail?.title ?? '通知'"
    width="560px"
    align-center
    append-to-body
    data-testid="notification-detail-dialog"
    @update:model-value="detail = null"
  >
    <p class="notification-detail__meta">
      <el-tag size="small" type="info">{{ kindLabel(detail?.kind ?? '') }}</el-tag>
      <span>{{ detail ? new Date(detail.createdAt).toLocaleString('zh-CN') : '' }}</span>
    </p>
    <div class="notification-detail__body">{{ detail?.body }}</div>
    <template #footer>
      <el-button round type="primary" @click="detail = null">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.notification-bell {
  /* 品牌行右侧对齐由父容器 flex space-between 控制，此处仅收内边距 */
  --el-badge-padding: 2px;
}
:global(.notification-drawer.el-drawer),
:global(.notification-drawer .el-drawer__header),
:global(.notification-drawer .el-drawer__body),
:global(.notification-drawer .el-drawer__footer) {
  background-color: var(--wg-surface, #fff) !important;
  color: var(--wg-ink, #1d1d1f) !important;
}
.notification-list {
  min-height: 120px;
}
.notification-item {
  padding: 10px 4px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  cursor: pointer;
}
.notification-item:hover {
  background: var(--el-fill-color-light);
}
.notification-item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.notification-item__time {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.notification-item__title {
  font-size: 14px;
  color: var(--el-text-color-regular);
}
/* 未读加粗（简报口径）：已读常规字重形成视觉区分 */
.notification-item.is-unread .notification-item__title {
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.notification-item__detail {
  padding: 0 2px;
  vertical-align: baseline;
}
.notification-detail__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  color: var(--wg-ink-muted);
  font-size: 12px;
}
.notification-detail__body {
  max-height: 55vh;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14px;
  line-height: 1.7;
}
.notification-item__body {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
