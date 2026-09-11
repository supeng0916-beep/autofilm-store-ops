<script setup lang="ts">
// 侧栏内容（2026-09-02 移动端适配拆出）：品牌行 + 全局搜索 + 分组菜单。
// 桌面渲染在 el-aside 内、手机渲染在抽屉内（AppLayout 按 isMobile 切换），
// 一份 markup 两处复用，菜单项与权限过滤仍由 AppLayout 统一计算传入。
import type { Component } from 'vue';

import GlobalSearch from '../search/GlobalSearch.vue';

export interface SidebarNavItem {
  index: string;
  title: string;
  icon: Component;
}
export interface SidebarNavGroup {
  group: string;
  items: SidebarNavItem[];
}

defineProps<{ groups: SidebarNavGroup[]; activeMenu: string }>();
</script>

<template>
  <nav class="sidebar-nav" aria-label="主导航">
    <div class="sidebar-nav__brand">
      <span class="sidebar-nav__brand-mark">AF</span>
      <span>
        <strong>AutoFilm Ops</strong>
        <small>门店工作台</small>
      </span>
    </div>
    <GlobalSearch class="sidebar-nav__search" />
    <!-- 滚动只发生在菜单区：矮窗口/手机抽屉下品牌与搜索框固定不动 -->
    <div class="sidebar-nav__menu">
      <el-menu router :default-active="activeMenu">
        <template v-for="section in groups" :key="section.group">
          <div class="sidebar-nav__group-label">{{ section.group }}</div>
          <el-menu-item v-for="item in section.items" :key="item.index" :index="item.index">
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.title }}</span>
          </el-menu-item>
        </template>
      </el-menu>
    </div>
  </nav>
</template>

<style scoped>
.sidebar-nav {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.sidebar-nav__menu {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
/* 菜单紧凑化（2026-08-21）：默认 56px 行高在矮窗口必出滚动条，44px 下 15 项 ≈660px 常规屏免滚；
 * 44px 同时是移动端可点击目标的下限（2026-09-02 手机适配沿用） */
.sidebar-nav__menu :deep(.el-menu) {
  border-right: none;
}
.sidebar-nav__menu :deep(.el-menu-item) {
  height: 44px;
  line-height: 44px;
  margin: 2px 10px;
  padding: 0 12px !important;
  border-radius: 8px;
  color: var(--wg-ink-muted);
  transition:
    color 160ms cubic-bezier(0.23, 1, 0.32, 1),
    background-color 160ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 160ms cubic-bezier(0.23, 1, 0.32, 1);
}
.sidebar-nav__menu :deep(.el-menu-item:hover) {
  color: var(--wg-ink);
  background-color: color-mix(in srgb, var(--wg-primary) 5%, transparent) !important;
  transform: translateX(2px);
}
.sidebar-nav__menu :deep(.el-menu-item.is-active) {
  color: var(--wg-primary) !important;
  background-color: color-mix(in srgb, var(--brand-gold) 13%, var(--wg-surface)) !important;
  box-shadow: inset 3px 0 0 var(--brand-gold);
  font-weight: 600;
}
.sidebar-nav__menu :deep(.el-menu-item:active) {
  transform: scale(0.98);
}
.sidebar-nav__menu :deep(.el-icon) {
  margin-right: 10px;
  font-size: 17px;
}
.sidebar-nav__group-label {
  padding: 18px 22px 6px;
  color: var(--brand-gold);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
}
.sidebar-nav__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 14px 12px 16px;
  font-weight: 600;
}
.sidebar-nav__brand > span:last-child {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sidebar-nav__brand strong {
  color: var(--wg-ink);
  font-size: 14px;
  letter-spacing: 0.04em;
}
.sidebar-nav__brand small {
  color: var(--wg-ink-muted);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.08em;
}
.sidebar-nav__brand-mark {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--brand-gold) 70%, transparent);
  border-radius: 10px;
  color: var(--brand-gold);
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 13px;
  letter-spacing: 0.05em;
}
.sidebar-nav__search {
  margin: 8px 16px;
}
/* 抽屉宿主下的收边（el-drawer__body 自带 20px padding，压回侧栏节奏） */
:global(.app-layout__nav-drawer .el-drawer__body) {
  padding: 0;
  overflow: hidden;
}
</style>
