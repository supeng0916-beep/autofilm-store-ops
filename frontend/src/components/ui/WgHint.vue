<script setup lang="ts">
// 按钮级悬停提示（2026-08-26 老板需求）：文案取自 hints.ts 注册表。
// 用法：<WgHint k="lead.copyDraft"><el-button ...>一键复制</el-button></WgHint>
// 缺 key 时不渲染 tooltip 直接透传（文案未补齐不阻塞功能）。
import { computed } from 'vue';

import { HINTS } from '../../hints/hints';

const props = withDefaults(
  defineProps<{
    k: string;
    placement?: 'top' | 'bottom' | 'left' | 'right';
  }>(),
  { placement: 'top' },
);

const content = computed(() => HINTS[props.k] ?? '');
</script>

<template>
  <el-tooltip
    v-if="content"
    :content="content"
    :placement="placement"
    :show-after="250"
    :hide-after="0"
  >
    <slot />
  </el-tooltip>
  <slot v-else />
</template>
