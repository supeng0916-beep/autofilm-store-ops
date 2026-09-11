<script setup lang="ts">
// 换装共用组件（V2.5 Task1）：指标卡——白卡 hairline + wg-num 大数字（alert 时红）。
defineProps<{
  label: string;
  value: string | number;
  /** 数字转红（SLA 到期等告警语义） */
  alert?: boolean;
  /** 补充口径说明（卡内最下一行小字） */
  tip?: string;
}>();
</script>

<template>
  <div class="wg-card stat-card">
    <div class="wg-num" :class="{ 'stat-card__num--alert': alert }">{{ value }}</div>
    <div class="wg-muted">{{ label }}</div>
    <div v-if="tip" class="stat-card__tip">{{ tip }}</div>
  </div>
</template>

<style scoped>
.stat-card {
  padding: 20px;
}
.stat-card__num--alert {
  color: var(--wg-danger);
}
.stat-card__tip {
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--wg-ink-muted);
}
</style>
