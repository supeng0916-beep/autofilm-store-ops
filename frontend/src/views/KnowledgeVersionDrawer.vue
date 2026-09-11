<script setup lang="ts">
// 知识库版本历史抽屉（V2.5 换装拆分子组件，S14 行数收口）：打开即自取该条目版本列表。
// 状态 pill 色板与列表页一致：生效绿 / 草稿灰 / 过期红。
// #14：新增「查看原始文件」入口——source 指向 门店知识源/ md 时跳转原文抽屉。
import { computed, ref, watch } from 'vue';

import { extractKnowledgeSourcePath, knowledgeApi, type KnowledgeItem } from '../api/knowledge';
import SourceFileDrawer from '../components/knowledge/SourceFileDrawer.vue';

const props = defineProps<{ item: KnowledgeItem | null }>();
const visible = defineModel<boolean>({ required: true });

const items = ref<KnowledgeItem[]>([]);
const loading = ref(false);
const rawDrawerRef = ref<InstanceType<typeof SourceFileDrawer> | null>(null);

const sourcePath = computed(() => extractKnowledgeSourcePath(props.item?.source));

const openRawFile = () => {
  if (sourcePath.value) rawDrawerRef.value?.open(sourcePath.value);
};

const STATUS_LABEL: Record<string, string> = { draft: '草稿', active: '生效', expired: '过期' };
const statusTag = (s: string) => (s === 'active' ? 'success' : s === 'expired' ? 'danger' : 'info');

watch(visible, (open) => {
  if (!open || !props.item) return;
  loading.value = true;
  items.value = [];
  knowledgeApi
    .versions(props.item.id)
    .then((list) => {
      items.value = list;
    })
    .finally(() => {
      loading.value = false;
    });
});
</script>

<template>
  <el-drawer v-model="visible" title="版本历史" size="400px">
    <div v-if="sourcePath" class="source-entry">
      <span class="source-label">来源：{{ props.item?.source }}</span>
      <el-button link type="primary" size="small" @click="openRawFile">查看原始文件</el-button>
    </div>
    <el-table v-loading="loading" :data="items" class="wg-table">
      <el-table-column prop="version" label="版本" width="60" />
      <el-table-column prop="title" label="标题" />
      <el-table-column prop="status" label="状态" width="80">
        <template #default="{ row }">
          <el-tag :type="statusTag(row.status)" size="small">{{
            STATUS_LABEL[row.status] ?? row.status
          }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="updatedAt" label="更新时间" width="160">
        <template #default="{ row }">{{ new Date(row.updatedAt).toLocaleString() }}</template>
      </el-table-column>
    </el-table>
    <SourceFileDrawer ref="rawDrawerRef" />
  </el-drawer>
</template>

<style scoped>
.source-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
}
.source-label {
  color: #7a7a7a;
  word-break: break-all;
}
</style>
