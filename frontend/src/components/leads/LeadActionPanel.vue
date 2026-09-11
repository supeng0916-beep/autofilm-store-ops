<script setup lang="ts">
// 客资详情子组件（P3-06 / V2.5 Task3）：右栏作业动作——阶段推进/流失建议/跟进记录三对话框。
// 表单态本地持有，确认时上抛 payload（api 与刷新由父级统一处理）；
// 对话框仅在父级提交成功后关闭（defineExpose.closeXxx，失败输入不丢）。
import { ref } from 'vue';

import { CHURN_REASONS, type FollowUpPayload } from './leadDisplay';

const props = defineProps<{
  canEdit: boolean;
  stageOptions: Array<{ value: string; label: string }>;
  contactSubmitting?: boolean;
  replySubmitting?: boolean;
  contacted?: boolean;
  customerReplied?: boolean;
}>();

const emit = defineEmits<{
  stage: [payload: { stage: string; reason: string }];
  churn: [payload: { reason: string; note?: string }];
  won: [payload: { amountFen: number; reason: string }];
  followup: [payload: FollowUpPayload];
  contactAttempt: [];
  customerReply: [];
}>();

// —— 阶段推进对话框（仅展示合法后继，与后端转移表对齐） ——
const stageDialogVisible = ref(false);
const stageTo = ref('');
const stageReason = ref('');

function submitStage(): void {
  if (!stageTo.value || !stageReason.value.trim()) return;
  emit('stage', { stage: stageTo.value, reason: stageReason.value.trim() });
}

function closeStageDialog(): void {
  stageDialogVisible.value = false;
  stageTo.value = '';
  stageReason.value = '';
}

// —— 标记成交对话框（2026-08-28 bug3：前端此前无成交入口，复盘「成交额」无从落数）——
const wonDialogVisible = ref(false);
const wonAmountYuan = ref<number | null>(null);
const wonReason = ref('');

function submitWon(): void {
  if (!wonAmountYuan.value || wonAmountYuan.value <= 0 || !wonReason.value.trim()) return;
  emit('won', {
    amountFen: Math.round(wonAmountYuan.value * 100), // 元 → 分（防浮点误差）
    reason: wonReason.value.trim(),
  });
}

function closeWonDialog(): void {
  wonDialogVisible.value = false;
  wonAmountYuan.value = null;
  wonReason.value = '';
}

// —— 流失建议对话框 ——
const churnDialogVisible = ref(false);
const churnReason = ref('');
const churnNote = ref('');

function submitChurn(): void {
  if (!churnReason.value) return;
  emit('churn', { reason: churnReason.value, note: churnNote.value.trim() || undefined });
}

function closeChurnDialog(): void {
  churnDialogVisible.value = false;
  churnReason.value = '';
  churnNote.value = '';
}

// —— 跟进记录对话框 ——
const followDialogVisible = ref(false);
const followResult = ref('');
const followNextAction = ref('');
const followNextAt = ref('');
const followWaitCustomer = ref(false);

function submitFollowUp(): void {
  if (!followResult.value.trim() || !followNextAction.value.trim() || !followNextAt.value) return;
  const nextFollowUpAt = new Date(followNextAt.value);
  if (Number.isNaN(nextFollowUpAt.getTime())) return;
  emit('followup', {
    result: followResult.value.trim(),
    nextAction: followNextAction.value.trim(),
    nextFollowUpAt: nextFollowUpAt.toISOString(),
    waitCustomer: followWaitCustomer.value,
  });
}

function closeFollowDialog(): void {
  followDialogVisible.value = false;
  followResult.value = '';
  followNextAction.value = '';
  followNextAt.value = '';
  followWaitCustomer.value = false;
}

defineExpose({ closeStageDialog, closeChurnDialog, closeFollowDialog, closeWonDialog });
</script>

<template>
  <section v-if="canEdit" class="wg-card lead-card">
    <h3 class="wg-card-title lead-card__title">作业动作</h3>
    <div class="lead-card__actions">
      <el-button
        round
        :type="props.contactSubmitting ? 'primary' : props.contacted ? 'success' : undefined"
        :plain="!props.contactSubmitting && !props.contacted"
        :loading="props.contactSubmitting"
        :disabled="props.contacted || props.contactSubmitting || props.replySubmitting"
        data-testid="contact-attempt-btn"
        @click="emit('contactAttempt')"
      >
        {{ props.contacted ? '已登记首次触达' : '登记首次触达' }}
      </el-button>
      <el-button
        round
        :type="props.replySubmitting ? 'primary' : props.customerReplied ? 'success' : undefined"
        :plain="!props.replySubmitting && !props.customerReplied"
        :loading="props.replySubmitting"
        :disabled="props.customerReplied || props.contactSubmitting || props.replySubmitting"
        data-testid="customer-reply-btn"
        @click="emit('customerReply')"
      >
        {{ props.customerReplied ? '已记录客户回复' : '客户已回复' }}
      </el-button>
      <el-button
        round
        :type="stageDialogVisible ? 'primary' : undefined"
        :plain="!stageDialogVisible"
        :disabled="stageOptions.length === 0 || props.contactSubmitting || props.replySubmitting"
        @click="stageDialogVisible = true"
      >
        阶段推进
      </el-button>
      <el-button
        v-if="canEdit"
        type="success"
        round
        data-testid="mark-won-btn"
        @click="wonDialogVisible = true"
        >标记成交</el-button
      >
      <el-button
        round
        :type="churnDialogVisible ? 'primary' : undefined"
        :plain="!churnDialogVisible"
        :disabled="props.contactSubmitting || props.replySubmitting"
        @click="churnDialogVisible = true"
        >流失建议</el-button
      >
      <el-button
        round
        :type="followDialogVisible ? 'primary' : undefined"
        :plain="!followDialogVisible"
        :disabled="props.contactSubmitting || props.replySubmitting"
        @click="followDialogVisible = true"
        >跟进记录</el-button
      >
    </div>

    <!-- 阶段推进对话框：仅展示合法后继 -->
    <el-dialog v-model="stageDialogVisible" title="阶段推进" width="480px">
      <el-select v-model="stageTo" placeholder="目标阶段" class="lead-card__full">
        <el-option
          v-for="opt in stageOptions"
          :key="opt.value"
          :label="opt.label"
          :value="opt.value"
        />
      </el-select>
      <el-input
        v-model="stageReason"
        placeholder="推进理由（≥2 字）"
        class="lead-card__full lead-card__mt"
      />
      <template #footer>
        <el-button @click="stageDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          round
          :disabled="!stageTo || !stageReason.trim()"
          @click="submitStage"
        >
          确认
        </el-button>
      </template>
    </el-dialog>

    <!-- 标记成交（2026-08-28 bug3）：成交价（元）+理由必填——复盘「成交额」的数据源 -->
    <el-dialog v-model="wonDialogVisible" title="标记成交" width="480px">
      <el-form label-width="88px">
        <el-form-item label="成交价（元）" required>
          <el-input-number
            v-model="wonAmountYuan"
            :min="1"
            :max="10000000"
            :step="100"
            data-testid="won-amount"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="成交说明" required>
          <el-input
            v-model="wonReason"
            type="textarea"
            :rows="2"
            placeholder="如：DM04 组合方案一，付定金 500（定金等细节写在这里）"
            data-testid="won-reason"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="wonDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          round
          :disabled="!wonAmountYuan || wonAmountYuan <= 0 || !wonReason.trim()"
          data-testid="won-submit"
          @click="submitWon"
        >
          确认成交
        </el-button>
      </template>
    </el-dialog>

    <!-- 流失建议对话框 -->
    <el-dialog v-model="churnDialogVisible" title="建议流失" width="480px">
      <el-select v-model="churnReason" placeholder="流失原因" class="lead-card__full">
        <el-option
          v-for="(label, value) in CHURN_REASONS"
          :key="value"
          :label="label"
          :value="value"
        />
      </el-select>
      <el-input
        v-model="churnNote"
        type="textarea"
        placeholder="流失说明（选「其他」必填）"
        class="lead-card__full lead-card__mt"
      />
      <template #footer>
        <el-button @click="churnDialogVisible = false">取消</el-button>
        <el-button type="primary" round :disabled="!churnReason" @click="submitChurn"
          >确认</el-button
        >
      </template>
    </el-dialog>

    <!-- 跟进记录对话框 -->
    <el-dialog v-model="followDialogVisible" title="跟进记录" width="480px">
      <el-input
        v-model="followResult"
        type="textarea"
        placeholder="跟进结果"
        class="lead-card__full"
      />
      <el-input
        v-model="followNextAction"
        placeholder="下次动作"
        class="lead-card__full lead-card__mt"
      />
      <el-date-picker
        v-model="followNextAt"
        type="datetime"
        placeholder="下次跟进时间"
        class="lead-card__full lead-card__mt"
      />
      <el-checkbox v-model="followWaitCustomer" class="lead-card__mt">等待客户回复</el-checkbox>
      <template #footer>
        <el-button @click="followDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          round
          :disabled="!followResult.trim() || !followNextAction.trim() || !followNextAt"
          @click="submitFollowUp"
        >
          确认
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
.lead-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.lead-card__full {
  width: 100%;
}
.lead-card__mt {
  margin-top: 8px;
}
</style>
