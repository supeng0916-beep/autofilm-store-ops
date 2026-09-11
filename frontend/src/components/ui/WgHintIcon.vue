<script setup lang="ts">
// 标题级「?」说明卡（2026-08-26 老板需求）：放在卡片/区块标题旁，**悬停或点击**均弹出两三句详细说明
// （2026-08-27 改悬停触发——老板实测悬停无反应，点击式不符合直觉）。
// 用法：<WgHintIcon k="lead.aiSummaryCard" />；文案取自 hints.ts 注册表，缺 key 时整个图标不渲染。
import { computed } from 'vue';

import { HINTS } from '../../hints/hints';

const props = defineProps<{ k: string }>();
const content = computed(() => HINTS[props.k] ?? '');
</script>

<template>
  <el-popover
    v-if="content"
    placement="bottom-start"
    :width="320"
    trigger="hover"
    :show-after="150"
    :hide-after="120"
  >
    <template #reference>
      <button
        class="wg-hint-icon__btn"
        type="button"
        aria-label="功能说明"
        data-testid="wg-hint-icon"
      >
        ?
      </button>
    </template>
    <p class="wg-hint-icon__body">{{ content }}</p>
  </el-popover>
</template>

<style scoped>
.wg-hint-icon__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: 6px;
  border: 1px solid var(--wg-hairline, #d2d2d7);
  border-radius: 50%;
  background: transparent;
  color: var(--wg-ink-muted, #6e6e73);
  font-size: 12px;
  line-height: 1;
  cursor: help;
  vertical-align: middle;
}
.wg-hint-icon__btn:hover {
  border-color: var(--wg-accent, #0066cc);
  color: var(--wg-accent, #0066cc);
}
.wg-hint-icon__body {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}
</style>
