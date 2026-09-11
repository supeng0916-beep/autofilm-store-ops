<script setup lang="ts">
// 客资详情子组件（P3-06 / V2.5 Task3）：中栏时间线（lead_events 倒序，纯展示）。
import type { LeadEventItem } from '../../api/leads';
import { EVENT_LABELS, STAGE_LABELS, fmt } from './leadDisplay';

defineProps<{ events: LeadEventItem[] }>();

/** 时间线事件摘要：优先展示 reason/to/result/text 等关键字段，缺失回退原始 kind */
function eventText(event: LeadEventItem): string {
  const c = event.content as Record<string, unknown> | null;
  if (c) {
    const reason = typeof c.reason === 'string' ? c.reason : '';
    const to = typeof c.to === 'string' ? (STAGE_LABELS[c.to] ?? c.to) : '';
    const result = typeof c.result === 'string' ? c.result : '';
    const text = typeof c.text === 'string' ? c.text : '';
    const evidence = typeof c.sendEvidence === 'string' ? `证据：${c.sendEvidence}` : '';
    const parts = [reason, to, result, text, evidence].filter(Boolean);
    if (parts.length > 0) return parts.join('；');
  }
  return EVENT_LABELS[event.kind] ?? event.kind;
}
</script>

<template>
  <section class="wg-card lead-card">
    <h3 class="wg-card-title lead-card__title">时间线</h3>
    <ul v-if="events.length" class="lead-card__timeline">
      <li v-for="evt in events" :key="evt.id" class="lead-card__event">
        <span class="lead-card__event-kind">{{ EVENT_LABELS[evt.kind] ?? evt.kind }}</span>
        <span class="lead-card__event-time">{{ fmt(evt.occurredAt) }}</span>
        <span class="lead-card__event-text">{{ eventText(evt) }}</span>
      </li>
    </ul>
    <p v-else class="lead-card__empty">暂无事件</p>
  </section>
</template>

<style scoped>
.lead-card__title {
  font-size: 17px;
  margin-bottom: 12px;
}
.lead-card__timeline {
  list-style: none;
  margin: 0;
  padding: 0;
}
.lead-card__event {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 0;
  border-bottom: 1px solid var(--wg-divider-soft);
  font-size: 13px;
}
.lead-card__event:last-child {
  border-bottom: none;
}
.lead-card__event-kind {
  font-weight: 600;
  color: var(--wg-primary);
}
.lead-card__event-time {
  color: var(--wg-ink-muted);
  font-size: 12px;
}
.lead-card__event-text {
  word-break: break-all;
}
.lead-card__empty {
  color: var(--wg-ink-muted);
  font-size: 13px;
}
</style>
