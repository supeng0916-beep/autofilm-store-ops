<script setup lang="ts">
// 404 兜底页：未匹配路由统一展示（P1 收尾项）
</script>

<template>
  <div class="not-found">
    <h1>404</h1>
    <p>页面不存在或已被移除</p>
    <router-link to="/">返回工作台</router-link>
  </div>
</template>

<style scoped>
.not-found {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
  gap: 12px;
}
</style>
