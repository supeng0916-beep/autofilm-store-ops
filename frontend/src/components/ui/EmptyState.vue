<script setup lang="ts">
// 换装共用组件（V2.5 Task1）：空态——el-empty 令牌化收口（image-size 60 统一小空态）。
defineProps<{ desc: string }>();
</script>

<template>
  <el-empty class="empty-state" :description="desc" :image-size="60" />
</template>

<style scoped>
.empty-state {
  padding: 16px 0;
}
.empty-state :deep(.el-empty__description p) {
  font-size: 12px;
  color: var(--wg-ink-muted);
}
</style>
