<script setup lang="ts">
import zhCn from 'element-plus/es/locale/lang/zh-cn';
</script>

<template>
  <el-config-provider :locale="zhCn">
    <router-view v-slot="{ Component }">
      <Transition name="route" mode="out-in">
        <component :is="Component" />
      </Transition>
    </router-view>
  </el-config-provider>
</template>

<style>
/* 路由级过渡（2026-08-21 品牌化）：登录→过渡页→工作台丝滑衔接 */
.route-enter-active,
.route-leave-active {
  transition:
    opacity 0.26s ease,
    transform 0.26s ease;
}
.route-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.route-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
@media (prefers-reduced-motion: reduce) {
  .route-enter-active,
  .route-leave-active {
    transition: opacity 0.12s ease;
  }
  .route-enter-from,
  .route-leave-to {
    transform: none;
  }
}
</style>
