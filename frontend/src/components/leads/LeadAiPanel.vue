<script setup lang="ts">
// 客资详情子组件（P3-06 / V2.5 Task3）：右栏 AI 摘要＋意向分级＋改判对话框。
// 摘要反馈/确认/改判动作全部上抛父级（api 与刷新由父级统一处理）；
// 改判对话框仅在父级提交成功后关闭（defineExpose.closeIntentDialog，失败留痕不丢输入）。
// 2026-08-26 O8 评测缺口：空态三态化（生成中/生成失败可重试/暂无可生成）——任务 8~20 秒完成，
// 详情页轮询期间由本面板呈现进度，不再让「暂无」误导使用者以为功能缺失。
import { computed, ref } from 'vue';

import type { AiSummary, IntentProposal, LeadAiProgress, LeadDetail } from '../../api/leads';
import EmptyState from '../ui/EmptyState.vue';
import WgHint from '../ui/WgHint.vue';
import WgHintIcon from '../ui/WgHintIcon.vue';
import { INTENT_LABELS } from './leadDisplay';

const props = defineProps<{
  summary: AiSummary | null;
  summaryStatus: LeadAiProgress;
  lead: LeadDetail | null;
  proposal: IntentProposal | null;
  proposalStatus: LeadAiProgress;
  canEdit: boolean;
  regenSubmitting: boolean;
  classifySubmitting: boolean;
}>();

const emit = defineEmits<{
  summaryFeedback: [decision: string, note?: string];
  confirmIntent: [];
  overrideIntent: [payload: { level: string; reason?: string }];
  regenerateSummary: [];
  generateProposal: [];
}>();

// —— 摘要反馈（2026-08-25 老板反馈「按钮无反应」）：状态回显 + 修改弹说明） ——
const FEEDBACK_LABEL: Record<string, string> = {
  adopted: '已采用',
  modified: '已修改采用',
  rejected: '已拒绝',
};

const summaryModifyVisible = ref(false);
const summaryModifyNote = ref('');

function submitModify(): void {
  const note = summaryModifyNote.value.trim();
  if (!note) return;
  emit('summaryFeedback', 'modified', note);
}

/** 提交成功后由父级调用关闭并清空（失败保持打开，输入不丢） */
function closeModifyDialog(): void {
  summaryModifyVisible.value = false;
  summaryModifyNote.value = '';
}

defineExpose({ closeIntentDialog, closeModifyDialog });

/** 意向等级标签类型（前端展示配色） */
function intentTagType(level: string): 'success' | 'warning' | 'info' | 'danger' {
  if (level === 'high') return 'success';
  if (level === 'mid') return 'warning';
  if (level === 'low') return 'info';
  return 'danger';
}

// —— 意向改判对话框（人工等级＋理由，与 AI 建议不一致时留痕 aiLevel/humanLevel） ——
// 2026-08-28 P2：理由必填（≥2 字，手册「改判需填理由」）——按钮禁用＋提交守卫前后双保险，
// 后端 intent-confirm 同口径 422
const intentDialogVisible = ref(false);
const intentOverrideLevel = ref('');
const intentOverrideReason = ref('');

function submitOverride(): void {
  if (!intentOverrideLevel.value || intentOverrideReason.value.trim().length < 2) return;
  emit('overrideIntent', {
    level: intentOverrideLevel.value,
    reason: intentOverrideReason.value.trim(),
  });
}

/** 提交成功后由父级调用关闭并重置（失败保持打开，输入不丢） */
function closeIntentDialog(): void {
  intentDialogVisible.value = false;
  intentOverrideLevel.value = '';
  intentOverrideReason.value = '';
}

const confidenceText = computed(() =>
  props.proposal ? `${(props.proposal.confidence * 100).toFixed(0)}%` : '',
);

/** 摘要空态是否可生成/重试（最新一次已定且无内容：none 从未生成或 degraded 全失败） */
const summaryRetryable = computed(
  () => props.summaryStatus !== 'pending' && props.canEdit && !props.summary,
);
</script>

<template>
  <section class="wg-card lead-card">
    <h3 class="wg-card-title lead-card__title">AI 摘要<WgHintIcon k="lead.aiSummaryCard" /></h3>
    <template v-if="summary">
      <el-alert
        v-if="summaryStatus === 'degraded'"
        class="lead-card__stale-alert"
        type="warning"
        :closable="false"
        show-icon
        title="最新一次生成失败，以下为上一版摘要"
      />
      <p class="lead-card__summary">{{ summary.summary }}</p>
      <div v-if="summary.nextAction" class="lead-card__next">
        建议动作：{{ summary.nextAction }}
      </div>
      <p v-if="summary.feedback" class="lead-card__feedback" data-testid="summary-feedback-state">
        <el-tag
          size="small"
          :type="summary.feedback.decision === 'rejected' ? 'danger' : 'success'"
        >
          {{ FEEDBACK_LABEL[summary.feedback.decision] ?? summary.feedback.decision }}
        </el-tag>
        <span class="lead-card__feedback-meta">
          {{ new Date(summary.feedback.createdAt).toLocaleString('zh-CN') }}
        </span>
        <span v-if="summary.feedback.note" class="lead-card__feedback-note">{{
          summary.feedback.note
        }}</span>
      </p>
      <div v-if="canEdit" class="lead-card__actions">
        <WgHint k="lead.adoptSummary" placement="top">
          <el-button size="small" round type="primary" @click="emit('summaryFeedback', 'adopted')">
            采用
          </el-button>
        </WgHint>
        <WgHint k="lead.modifySummary" placement="top">
          <el-button size="small" round @click="summaryModifyVisible = true">修改</el-button>
        </WgHint>
        <WgHint k="lead.rejectSummary" placement="top">
          <el-button size="small" round type="danger" @click="emit('summaryFeedback', 'rejected')">
            拒绝
          </el-button>
        </WgHint>
        <WgHint k="lead.regenerateSummary" placement="top">
          <el-button
            v-if="summaryStatus === 'degraded'"
            size="small"
            round
            :loading="regenSubmitting"
            data-testid="summary-regenerate-btn"
            @click="emit('regenerateSummary')"
          >
            重新生成
          </el-button>
        </WgHint>
      </div>
    </template>
    <div
      v-else-if="summaryStatus === 'pending'"
      class="lead-card__pending"
      data-testid="summary-pending"
    >
      <span class="lead-card__spinner" aria-hidden="true"></span>
      AI 正在生成摘要，约 10~20 秒后自动显示
    </div>
    <div v-else-if="summaryRetryable" class="lead-card__pending">
      <span v-if="summaryStatus === 'degraded'" class="lead-card__pending-warn">
        AI 摘要生成失败（模型输出未通过校验）
      </span>
      <el-button
        size="small"
        round
        :loading="regenSubmitting"
        data-testid="summary-generate-btn"
        @click="emit('regenerateSummary')"
      >
        {{ summaryStatus === 'none' ? '生成 AI 摘要' : '重新生成' }}
      </el-button>
    </div>
    <EmptyState v-else desc="暂无 AI 摘要" />

    <h3 class="wg-card-title lead-card__title lead-card__title--mt">
      意向分级<WgHintIcon k="lead.intentCard" />
    </h3>
    <template v-if="lead">
      <p class="lead-card__field">
        <span class="lead-card__label">已确认</span>
        <el-tag :type="intentTagType(lead.intentLevel)" size="small">
          {{ INTENT_LABELS[lead.intentLevel] ?? lead.intentLevel }}
        </el-tag>
      </p>
    </template>
    <template v-if="proposal">
      <div class="lead-card__intent">
        <p class="lead-card__field">
          <span class="lead-card__label">建议等级</span>
          <el-tag :type="intentTagType(proposal.level)" size="small">
            {{ INTENT_LABELS[proposal.level] ?? proposal.level }}
          </el-tag>
          <span class="lead-card__confidence">置信度 {{ confidenceText }}</span>
        </p>
        <div v-if="proposal.evidence.length" class="lead-card__intent-list">
          <p class="lead-card__intent-title">证据</p>
          <ul>
            <li v-for="e in proposal.evidence" :key="e">{{ e }}</li>
          </ul>
        </div>
        <div v-if="proposal.missingInfo.length" class="lead-card__intent-list">
          <p class="lead-card__intent-title">缺失信息</p>
          <ul>
            <li v-for="m in proposal.missingInfo" :key="m">{{ m }}</li>
          </ul>
        </div>
        <p v-if="proposal.nextAction" class="lead-card__field">
          <span class="lead-card__label">建议动作</span>{{ proposal.nextAction }}
        </p>
      </div>
      <div v-if="canEdit" class="lead-card__actions">
        <WgHint k="lead.confirmIntent" placement="top">
          <el-button size="small" round type="primary" @click="emit('confirmIntent')">
            确认
          </el-button>
        </WgHint>
        <WgHint k="lead.overrideIntent" placement="top">
          <el-button size="small" round @click="intentDialogVisible = true">改判并确认</el-button>
        </WgHint>
      </div>
    </template>
    <div v-if="!proposal" class="lead-card__intent-empty">
      <div
        v-if="proposalStatus === 'pending'"
        class="lead-card__pending"
        data-testid="proposal-pending"
      >
        <span class="lead-card__spinner" aria-hidden="true"></span>
        AI 正在生成分级建议，约 10~20 秒后自动显示
      </div>
      <template v-else>
        <p class="lead-card__empty">暂无意向建议</p>
        <el-button
          v-if="canEdit"
          size="small"
          round
          :loading="classifySubmitting"
          data-testid="proposal-generate-btn"
          @click="emit('generateProposal')"
        >
          生成分级建议
        </el-button>
      </template>
    </div>

    <!-- 摘要修改说明对话框：decision=modified + note 留痕（AI 输出不回写，修改意见入反馈链） -->
    <el-dialog v-model="summaryModifyVisible" title="修改摘要（记录修改说明）" width="480px">
      <el-input
        v-model="summaryModifyNote"
        type="textarea"
        :rows="3"
        placeholder="哪里不对/需要补充（≥2 字，会随反馈留痕供 AI 改进）"
        data-testid="summary-modify-note"
      />
      <template #footer>
        <el-button @click="summaryModifyVisible = false">取消</el-button>
        <el-button
          type="primary"
          round
          :disabled="summaryModifyNote.trim().length < 2"
          data-testid="summary-modify-submit"
          @click="submitModify"
        >
          提交修改说明
        </el-button>
      </template>
    </el-dialog>

    <!-- 改判对话框：人工等级＋理由（与 AI 建议不一致时留痕 aiLevel/humanLevel）；
         理由必填 ≥2 字（2026-08-28 P2，后端同口径 422） -->
    <el-dialog v-model="intentDialogVisible" title="改判并确认意向" width="480px">
      <el-select v-model="intentOverrideLevel" placeholder="意向等级" class="lead-card__full">
        <el-option
          v-for="(label, value) in INTENT_LABELS"
          :key="value"
          :label="label"
          :value="value"
        />
      </el-select>
      <el-input
        v-model="intentOverrideReason"
        type="textarea"
        placeholder="改判理由（必填，≥2 字）"
        class="lead-card__full lead-card__mt"
        data-testid="intent-override-reason"
      />
      <template #footer>
        <el-button @click="intentDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          round
          :disabled="!intentOverrideLevel || intentOverrideReason.trim().length < 2"
          data-testid="intent-override-submit"
          @click="submitOverride"
        >
          确认改判
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
/* AI 摘要/草稿区浅灰底卡片（V2.5 令牌）：白卡内的软底信息块 */
.lead-card__title {
  font-size: 17px;
  margin-bottom: 12px;
}
/* 生成中态（2026-08-26 O8 缺口）：转圈 + 说明，替代误导性的「暂无」 */
.lead-card__pending {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--wg-canvas);
  border-radius: 10px;
  font-size: 13px;
  color: var(--wg-ink-muted);
}
.lead-card__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--wg-hairline, #d2d2d7);
  border-top-color: var(--wg-accent, #0066cc);
  border-radius: 50%;
  animation: lead-card-spin 0.8s linear infinite;
  flex: none;
}
@keyframes lead-card-spin {
  to {
    transform: rotate(360deg);
  }
}
.lead-card__pending-warn {
  color: #b02a1f;
  font-size: 12px;
  margin-bottom: 8px;
}
.lead-card__stale-alert {
  margin-bottom: 8px;
}
.lead-card__intent-empty {
  margin-top: 4px;
}
.lead-card__title--mt {
  margin-top: 20px;
}
.lead-card__summary {
  margin: 0 0 8px;
  padding: 10px 12px;
  background: var(--wg-canvas);
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-all;
}
.lead-card__next {
  margin: 8px 0;
  padding: 8px 12px;
  background: #e6f0fa;
  border-radius: 10px;
  font-size: 13px;
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
.lead-card__empty {
  color: var(--wg-ink-muted);
  font-size: 13px;
}
.lead-card__intent {
  margin: 8px 0;
}
.lead-card__confidence {
  margin-left: 8px;
  color: var(--wg-ink-muted);
  font-size: 12px;
}
.lead-card__intent-list {
  margin: 6px 0;
}
.lead-card__intent-list ul {
  margin: 2px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: #606266;
}
.lead-card__intent-title {
  font-size: 12px;
  color: var(--wg-ink-muted);
  margin: 0;
}
.lead-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.lead-card__feedback {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 0;
  font-size: 12px;
}
.lead-card__feedback-meta {
  color: var(--wg-ink-muted);
}
.lead-card__feedback-note {
  flex: 1 1 100%;
  color: var(--wg-ink-muted);
  word-break: break-all;
}
.lead-card__full {
  width: 100%;
}
.lead-card__mt {
  margin-top: 8px;
}
</style>
