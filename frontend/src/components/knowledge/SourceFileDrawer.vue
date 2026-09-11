<script setup lang="ts">
// 知识源文件抽屉（#14）：调 /knowledge/source-file 渲染 门店知识源/ md 纯文本。
// 助手来源卡片、知识库版本抽屉共用——父组件经 ref 调 open(path) 打开。
import { ref } from 'vue';

import { knowledgeApi, type KnowledgeSourceFile } from '../../api/knowledge';

const visible = ref(false);
const loading = ref(false);
const file = ref<KnowledgeSourceFile | null>(null);

const open = async (path: string) => {
  visible.value = true;
  loading.value = true;
  try {
    file.value = await knowledgeApi.sourceFile(path);
  } catch {
    file.value = null; // http 拦截器已 toast
  } finally {
    loading.value = false;
  }
};

defineExpose({ open });
</script>

<template>
  <el-drawer v-model="visible" :title="file?.path ?? '知识源文件'" size="50%" append-to-body>
    <div v-loading="loading" class="source-file-body">
      <pre v-if="file" class="source-raw">{{ file.content }}</pre>
      <el-empty v-else-if="!loading" description="文件内容为空或加载失败" :image-size="60" />
    </div>
  </el-drawer>
</template>

<style scoped>
.source-file-body {
  min-height: 120px;
}
.source-raw {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--el-font-family-mono, 'SF Mono', Menlo, Consolas, monospace);
  font-size: 13px;
  line-height: 1.7;
  color: #1d1d1f;
}
</style>
