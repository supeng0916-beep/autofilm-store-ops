<script setup lang="ts">
// 换装共用组件（V2.5 Task1）：页面标题行——标题 21px/600 + 次要说明 + 右侧动作槽。
// 纯展示（零交互），供各功能页统一页首气质。
defineProps<{ title: string; sub?: string }>();
</script>

<template>
  <header class="page-header">
    <div class="page-header__text">
      <h2 class="page-header__title">{{ title }}</h2>
      <p v-if="sub" class="page-header__sub">{{ sub }}</p>
    </div>
    <div v-if="$slots.actions" class="page-header__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 16px;
  margin-bottom: 24px;
}
.page-header__title {
  margin: 0;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: 0.23px;
  color: var(--wg-ink);
}
.page-header__sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--wg-ink-muted);
}
.page-header__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
/* 手机（2026-09-02 移动端适配）：标题与动作按钮上下堆叠——
 * 375px 宽放不下「标题+说明+两三个圆角按钮」一行，堆叠后按钮整行可点 */
@media (max-width: 768px) {
  .page-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 16px;
  }
  .page-header__actions {
    flex-wrap: wrap;
    width: 100%;
  }
}
</style>
