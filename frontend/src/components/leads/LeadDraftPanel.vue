<script setup lang="ts">
// 客资详情子组件（P3-06 / V2.5 Task3）：右栏草稿工作区＋历史草稿＋记录发送对话框。
// 草稿正文/当前任务经 v-model 与父级双向（父级 onCopy 读正文调剪贴板）；
// 「已复制」≠「已发送」：发送对话框强制证据文本域（≥10 字），无证据提交禁用；
// 发送对话框仅在父级提交成功后关闭（defineExpose.closeSendDialog，失败证据不丢）。
import { computed, ref } from 'vue';

import type { DraftItem } from '../../api/leads';
import EmptyState from '../ui/EmptyState.vue';
import { fmt } from './leadDisplay';

defineProps<{
  canEdit: boolean;
  generating: boolean;
  drafts: DraftItem[];
  notes: string;
}>();

const text = defineModel<string>('text', { default: '' });
const taskId = defineModel<string | null>('taskId', { default: null });

const emit = defineEmits<{
  generate: [goal: string];
  copy: [];
  save: [];
  send: [evidence: string];
}>();

// —— 生成区（本轮目标仅前端体验参数） ——
const draftGoal = ref('');

// —— 记录发送对话框：证据必填（≥10 字） ——
const sendDialogVisible = ref(false);
const sendEvidence = ref('');
const sendEvidenceValid = computed(() => sendEvidence.value.trim().length >= 10);

function submitSend(): void {
  if (!sendEvidenceValid.value || !taskId.value) return;
  emit('send', sendEvidence.value.trim());
}

/** 提交成功后由父级调用关闭并重置（失败保持打开，证据不丢） */
function closeSendDialog(): void {
  sendDialogVisible.value = false;
  sendEvidence.value = '';
}

defineExpose({ closeSendDialog });
</script>

<template>
  <section class="wg-card lead-card">
    <h3 class="wg-card-title lead-card__title">草稿工作区</h3>
    <div v-if="canEdit" class="lead-card__draft">
      <div class="lead-card__draft-gen">
        <el-input v-model="draftGoal" placeholder="本轮目标（可选，如：约到店看色卡）" />
        <el-button type="primary" round :loading="generating" @click="emit('generate', draftGoal)">
          生成草稿
        </el-button>
      </div>
      <el-input
        v-model="text"
        type="textarea"
        :rows="4"
        placeholder="草稿正文（可直接复制发送）"
        class="lead-card__draft-text"
      />
      <p v-if="notes" class="lead-card__field">
        <span class="lead-card__label">备注</span>{{ notes }}
      </p>
      <div class="lead-card__draft-actions">
        <el-button type="primary" round :disabled="!text.trim()" @click="emit('copy')">
          一键复制
        </el-button>
        <el-button round :disabled="!taskId" @click="emit('save')">保存改写</el-button>
        <el-button type="success" round :disabled="!taskId" @click="sendDialogVisible = true">
          记录为已发送
        </el-button>
      </div>

      <h4 class="lead-card__subtitle">历史草稿</h4>
      <ul v-if="drafts.length" class="lead-card__draft-list">
        <li
          v-for="d in drafts"
          :key="`${d.taskId}-${d.version}`"
          class="lead-card__draft-item"
          @click="
            text = d.text;
            taskId = d.taskId;
          "
        >
          <span class="lead-card__item-kind">{{
            d.source === 'ai' ? 'AI' : `改写 v${d.version}`
          }}</span>
          <span class="lead-card__item-time">{{ fmt(d.createdAt) }}</span>
        </li>
      </ul>
      <EmptyState v-else desc="暂无历史草稿" />
    </div>
    <p v-else class="lead-card__empty">无编辑权限，草稿工作区不可用</p>

    <!-- 记录发送对话框：证据必填（≥10 字） -->
    <el-dialog v-model="sendDialogVisible" title="记录为已发送" width="480px">
      <p class="lead-card__hint">
        请粘贴实际发送证据（聊天导入片段等，≥10 字）。已复制不等于已发送。
      </p>
      <el-input
        v-model="sendEvidence"
        type="textarea"
        :rows="4"
        placeholder="实际发送的证据（如聊天片段）"
      />
      <template #footer>
        <el-button @click="sendDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          round
          :disabled="!sendEvidenceValid"
          data-test="send-submit"
          @click="submitSend"
        >
          确认已发送
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.lead-card__title {
  font-size: 17px;
  margin-bottom: 12px;
}
/* 草稿区浅灰底（V2.5 令牌）：软底工作区块 */
.lead-card__draft {
  padding: 12px;
  background: var(--wg-canvas);
  border-radius: 12px;
}
.lead-card__draft-gen {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.lead-card__draft-gen :deep(.el-input) {
  min-width: 0;
  flex: 1;
}
.lead-card__draft-gen :deep(.el-button) {
  flex: 0 0 auto;
}
.lead-card__draft-text {
  margin-top: 8px;
}
.lead-card__field {
  margin: 4px 0;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-all;
}
.lead-card__label {
  display: inline-block;
  min-width: 64px;
  color: var(--wg-ink-muted);
}
.lead-card__draft-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 8px;
}
.lead-card__draft-actions :deep(.el-button) {
  width: 100%;
  min-width: 0;
  margin: 0;
}
.lead-card__draft-actions :deep(.el-button:last-child) {
  grid-column: 1 / -1;
}
@media (max-width: 420px) {
  .lead-card__draft-actions {
    grid-template-columns: 1fr;
  }
  .lead-card__draft-actions :deep(.el-button:last-child) {
    grid-column: auto;
  }
}
.lead-card__subtitle {
  margin: 12px 0 8px;
  font-size: 13px;
  color: var(--wg-ink-muted);
}
.lead-card__draft-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.lead-card__draft-item {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  cursor: pointer;
  font-size: 13px;
}
.lead-card__draft-item:hover {
  color: var(--wg-primary);
}
.lead-card__item-kind {
  font-weight: 600;
  color: var(--wg-primary);
}
.lead-card__item-time {
  color: var(--wg-ink-muted);
  font-size: 12px;
}
.lead-card__empty {
  color: var(--wg-ink-muted);
  font-size: 13px;
}
.lead-card__hint {
  font-size: 12px;
  color: var(--wg-ink-muted);
  margin: 0 0 8px;
}
</style>
