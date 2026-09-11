<script setup lang="ts">
/* global URL, window */
// 素材卡片（2026-08-25 从 AssetsView 抽取）：按车型分组视图与非照片类平铺视图共用同一张卡。
// m06:view 可看；编辑位（勾选/授权/标签/删除）由父级 canEdit 门控传入，AI 建议仅 m06:edit。
// 文件经带令牌请求取 blob URL 展示——/assets/:id/* 在全局 Bearer 守卫之后，
// <img>/window.open 无法携带 Authorization 头（直链会 401），见 api/asset.ts 注释。
import {
  assetApi,
  ASSET_KIND_LABEL,
  formatDuration,
  type Asset,
  type AssetKind,
} from '../../api/asset';

const props = defineProps<{
  asset: Asset;
  /** 缩略 blob URL（父级按展开组懒加载缓存；未就绪时显示占位） */
  src?: string;
  selected?: boolean;
  canEdit?: boolean;
  canSuggest?: boolean;
  /** AI 建议轮询中（当前建议目标即本卡时显示 loading） */
  suggesting?: boolean;
}>();

const emit = defineEmits<{
  'toggle-select': [value: boolean];
  'toggle-licensed': [value: boolean];
  'edit-tags': [];
  suggest: [];
  remove: [];
}>();

const kindLabel = (k: string) => ASSET_KIND_LABEL[k as AssetKind] ?? k;
const fmt = (v: string) => new Date(v).toLocaleDateString('zh-CN');

/** PDF 新窗口打开（blob URL 携带服务端 Content-Type，浏览器内建阅读器渲染） */
async function openPdf(): Promise<void> {
  try {
    window.open(URL.createObjectURL(await assetApi.fetchFile(props.asset.id)), '_blank');
  } catch {
    // http 拦截器已 toast
  }
}
</script>

<template>
  <el-card class="asset-card" shadow="hover">
    <el-checkbox
      v-if="canEdit"
      class="asset-card__select"
      :model-value="selected"
      @change="(v: string | number | boolean) => emit('toggle-select', v === true)"
    />
    <!-- image：thumb 端点缩略 + el-image 大图预览；video：图标占位 + 时长；document：PDF 占位点击新窗口 -->
    <el-image
      v-if="asset.mediaType === 'image'"
      class="asset-card__cover"
      :src="src"
      fit="cover"
      lazy
      :preview-src-list="src ? [src] : []"
      preview-teleported
    >
      <template #error>
        <div class="asset-card__ph">图片加载中…</div>
      </template>
    </el-image>
    <div v-else-if="asset.mediaType === 'video'" class="asset-card__cover asset-card__video">
      <span class="asset-card__video-icon">🎬</span>
      <span>视频 · {{ formatDuration(asset.duration) }}</span>
    </div>
    <div v-else class="asset-card__cover asset-card__pdf" @click="openPdf">
      <span class="asset-card__pdf-icon">📄</span>
      <span>PDF · 点击新窗口查看</span>
    </div>
    <div class="asset-card__body">
      <div class="asset-card__tags">
        <el-tag size="small">{{ kindLabel(asset.kind) }}</el-tag>
        <el-tag v-if="asset.carModel" size="small" type="info">{{ asset.carModel }}</el-tag>
        <el-tag v-if="asset.productModel" size="small" type="info">{{ asset.productModel }}</el-tag>
        <el-tag v-for="t in asset.tags" :key="t" size="small" type="warning">{{ t }}</el-tag>
        <el-tag size="small" :type="asset.licensed ? 'success' : 'info'">
          {{ asset.licensed ? '已授权' : '内部' }}
        </el-tag>
      </div>
      <div class="asset-card__title" :title="asset.title">{{ asset.title }}</div>
      <div class="asset-card__meta">
        {{ asset.technicianName ? `${asset.technicianName} · ` : '' }}{{ fmt(asset.createdAt) }}
      </div>
      <div v-if="canEdit" class="asset-card__actions">
        <el-tooltip
          content="客户同意对外展示（发圈/文案配图）才打开；默认「内部」=仅店内使用"
          placement="top"
        >
          <el-switch
            :model-value="asset.licensed"
            size="small"
            active-text="授权"
            data-testid="licensed-switch"
            @change="(v: string | number | boolean) => emit('toggle-licensed', v === true)"
          />
        </el-tooltip>
        <el-tooltip content="标签=检索关键词，AI 引用素材时按标签/车型匹配" placement="top">
          <el-button size="small" text type="primary" @click="emit('edit-tags')"
            >编辑标签</el-button
          >
        </el-tooltip>
        <el-button
          v-if="canSuggest"
          size="small"
          text
          type="primary"
          :loading="suggesting"
          @click="emit('suggest')"
          >AI建议标签</el-button
        >
        <el-button size="small" text type="danger" @click="emit('remove')">删除</el-button>
      </div>
    </div>
  </el-card>
</template>

<style scoped>
.asset-card {
  position: relative;
}
.asset-card :deep(.el-card__body) {
  padding: 0;
}
.asset-card__select {
  position: absolute;
  top: 6px;
  left: 8px;
  z-index: 2;
  background: var(--el-mask-color-lighter);
  border-radius: 4px;
  padding: 0 4px;
}
.asset-card__cover {
  width: 100%;
  height: 160px;
  display: block;
}
.asset-card__pdf,
.asset-card__video {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.asset-card__pdf {
  cursor: pointer;
}
.asset-card__pdf-icon,
.asset-card__video-icon {
  font-size: 40px;
  line-height: 1;
}
.asset-card__ph {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.asset-card__body {
  padding: 10px 12px 12px;
}
.asset-card__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.asset-card__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asset-card__meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.asset-card__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
</style>
