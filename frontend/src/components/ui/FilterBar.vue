<script setup lang="ts">
// 换装共用组件（V2.5 Task1）：筛选条——横向 slot 容器 + 统一底部间距。
// 仅管布局，不含任何筛选逻辑（各页自持筛选状态与查询动作）。
</script>

<template>
  <div class="filter-bar">
    <slot />
  </div>
</template>

<style scoped>
.filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
</style>
