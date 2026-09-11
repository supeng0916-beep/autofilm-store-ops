<script setup lang="ts">
// 施工单展开行详情卡（V2.5 换装拆分子组件，S14 行数收口）：纯展示，无交互。
import type { WorkOrder } from '../api/workOrder';

defineProps<{ order: WorkOrder }>();

const fmt = (v: string | null) => (v ? new Date(v).toLocaleString('zh-CN') : '-');

/** 展开行返工原因汇总（一屏看完，便于回溯） */
const reworkReasons = (w: WorkOrder) => (w.reworkRecords ?? []).map((r) => r.reason).join('；');
</script>

<template>
  <div class="wo-expand">
    <p v-if="order.selfCheck">
      自检：{{ order.selfCheck.byName }} {{ fmt(order.selfCheck.at) }}（原时间
      {{ fmt(order.selfCheck.occurredAt ?? order.selfCheck.at) }}）
    </p>
    <p v-if="order.recheck">复检：{{ order.recheck.byName }} {{ fmt(order.recheck.at) }}</p>
    <p>
      照片：{{ order.photos?.length ?? 0 }} 张｜异常：{{ order.abnormal?.length ?? 0 }} 条｜返工：{{
        order.reworkRecords?.length ?? 0
      }}
      次
    </p>
    <p v-if="order.reworkRecords">返工记录：{{ reworkReasons(order) }}</p>
    <p v-if="order.careNotes">
      养护说明：{{
        order.careNotes.confirmed ? `已确认（${order.careNotes.confirmed.byName}）` : '草稿未确认'
      }}
    </p>
    <pre v-if="order.careNotes" class="wo-expand__care">{{
      order.careNotes.confirmed?.content ?? order.careNotes.draft
    }}</pre>
    <p v-if="order.caseRequest">
      案例授权：{{ order.caseRequest.authorized ? '已授权' : '未授权' }}（{{
        fmt(order.caseRequest.at)
      }}）
    </p>
  </div>
</template>

<style scoped>
/* 展开行内容卡片化（V2.5 令牌：浅灰底 + 圆角 + 内边距） */
.wo-expand {
  max-width: 720px;
  margin: 4px 0 8px;
  padding: 12px 16px;
  background: var(--wg-canvas);
  border-radius: 12px;
}
.wo-expand__care {
  white-space: pre-wrap;
  font-family: inherit;
  background: var(--wg-surface);
  border: 1px solid var(--wg-hairline);
  border-radius: 8px;
  padding: 10px 12px;
}
</style>
