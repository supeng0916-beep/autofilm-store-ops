<script setup lang="ts">
/* global navigator, setInterval, clearInterval */
// 客资详情（P3-06 / V2.5 Task3 拆分）：本文件为编排层——状态＋api 动作＋两栏布局；
// 卡片渲染拆至 components/leads/（字段卡/时间线/AI 面板/草稿面板/作业动作面板）。
// 布局（2026-08-27 排版重构）：左栏只读信息区（客资信息＋时间线），右栏工作区（作业动作置顶——
// 高频操作零滚动直达；其下草稿工作区、AI 建议面板）；窄屏折叠为单列。
// 「已复制」≠「已发送」：复制仅剪贴板成功后调 copy 端点；发送对话框强制证据（≥10 字，子面板内校验）。
// 对话框关闭时机：子面板 emit 后父级调 api，成功才调子级 closeXxx（失败保持打开不丢输入）。
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';

import {
  leadsApi,
  type AiSummary,
  type DraftItem,
  type IntentProposal,
  type LeadAiProgress,
  type LeadDetail,
  type LeadEventItem,
} from '../api/leads';
import { orderApi, type OrderConfirmation } from '../api/order';
import LeadActionPanel from '../components/leads/LeadActionPanel.vue';
import LeadAiPanel from '../components/leads/LeadAiPanel.vue';
import LeadDraftPanel from '../components/leads/LeadDraftPanel.vue';
import LeadFieldCard from '../components/leads/LeadFieldCard.vue';
import LeadTimelineCard from '../components/leads/LeadTimelineCard.vue';
import { fmt, STAGE_LABELS, type FollowUpPayload } from '../components/leads/leadDisplay';
import { leadProfileApi } from '../api/leads';
import PageHeader from '../components/ui/PageHeader.vue';
import { usePermission } from '../composables/usePermission';

const route = useRoute();
const leadId = route.params.id as string;
const { can } = usePermission();
const canEdit = computed(() => can('m03:edit'));

// —— 客户画像编辑（批次2 T8）：五字段可选至少一项，调 PATCH /leads/:id/profile ——
const profileDialog = ref(false);
const profileSaving = ref(false);
const profileForm = ref<{
  gender: '' | 'male' | 'female';
  ageBand: string;
  industry: string;
  district: string;
  purchaseDealer: string;
}>({ gender: '', ageBand: '', industry: '', district: '', purchaseDealer: '' });

function openProfileDialog(): void {
  profileForm.value = {
    gender: (lead.value?.gender as 'male' | 'female') ?? '',
    ageBand: lead.value?.ageBand ?? '',
    industry: lead.value?.industry ?? '',
    district: lead.value?.district ?? '',
    purchaseDealer: lead.value?.purchaseDealer ?? '',
  };
  profileDialog.value = true;
}

async function submitProfile(): Promise<void> {
  if (!lead.value) return;
  const f = profileForm.value;
  const data: Record<string, string> = {};
  if (f.gender) data.gender = f.gender;
  if (f.ageBand) data.ageBand = f.ageBand;
  if (f.industry.trim()) data.industry = f.industry.trim();
  if (f.district.trim()) data.district = f.district.trim();
  if (f.purchaseDealer.trim()) data.purchaseDealer = f.purchaseDealer.trim();
  if (Object.keys(data).length === 0) {
    ElMessage.warning('至少填写一项画像字段');
    return;
  }
  profileSaving.value = true;
  try {
    await leadProfileApi.updateProfile(
      lead.value.id,
      data as Parameters<typeof leadProfileApi.updateProfile>[1],
    );
    ElMessage.success('画像已更新');
    profileDialog.value = false;
    await load();
  } finally {
    profileSaving.value = false;
  }
}

const lead = ref<LeadDetail | null>(null);
const events = ref<LeadEventItem[]>([]);
const summary = ref<AiSummary | null>(null);
const summaryStatus = ref<LeadAiProgress>('none');
const drafts = ref<DraftItem[]>([]);
const proposal = ref<IntentProposal | null>(null);
const proposalStatus = ref<LeadAiProgress>('none');
const loading = ref(false);
const feedbackSubmitting = ref(false);
const contactSubmitting = ref(false);
const replySubmitting = ref(false);
const regenSubmitting = ref(false);
const classifySubmitting = ref(false);

// —— 订单确认（批次1 Task 8）：仅已成交客资显示；金额分存元显（表单元输入 ×100 转分提交） ——
const orderInfo = ref<OrderConfirmation | null>(null);
const orderSubmitting = ref(false);
const orderConfirming = ref(false);
const orderForm = ref({
  products: '',
  quoteSnapshot: '',
  discountNote: '',
  depositYuan: 0,
  balanceYuan: 0,
  // 材料成本（元，批次4）：选填，null=未录入（提交时省略该键，复盘毛利口径不计入；同投流费口径）
  materialCostYuan: null as number | null,
  payMethod: '',
});

/** 付款方式选项（取值对齐后端 PAY_METHOD_VALUES / PAY_METHOD_LABEL） */
const PAY_METHOD_OPTIONS = [
  { value: 'wechat', label: '微信' },
  { value: 'alipay', label: '支付宝' },
  { value: 'cash', label: '现金' },
  { value: 'card', label: '刷卡' },
  { value: 'other', label: '其他' },
];
const PAY_METHOD_LABELS: Record<string, string> = Object.fromEntries(
  PAY_METHOD_OPTIONS.map((o) => [o.value, o.label]),
);

/** 金额分 → 元展示（两位小数） */
function fenToYuan(fen: number): string {
  return (fen / 100).toFixed(2);
}

/** 拉取该客资的订单确认单（后端按 leadId 过滤、同客资唯一；失败不阻断整页） */
async function loadOrderInfo(): Promise<void> {
  orderInfo.value = await orderApi.byLead(leadId).catch(() => null);
}

/** 创建订单确认单：元输入 ×100 转分提交（Math.round 防浮点误差，同标记成交口径） */
async function submitOrder(): Promise<void> {
  const f = orderForm.value;
  if (!f.products.trim() || !f.quoteSnapshot.trim() || orderSubmitting.value) return;
  orderSubmitting.value = true;
  try {
    orderInfo.value = await orderApi.create({
      leadId,
      products: f.products.trim(),
      quoteSnapshot: f.quoteSnapshot.trim(),
      ...(f.discountNote.trim() ? { discountNote: f.discountNote.trim() } : {}),
      depositFen: Math.round(f.depositYuan * 100),
      balanceFen: Math.round(f.balanceYuan * 100),
      // 材料成本元转分（批次4）：未录入（null/0）不传该键——与"未录成本"口径一致（同投流费写法）
      ...(f.materialCostYuan ? { materialCostFen: Math.round(f.materialCostYuan * 100) } : {}),
      ...(f.payMethod ? { payMethod: f.payMethod } : {}),
    });
    ElMessage.success('订单确认单已创建');
  } catch {
    // 错误由 http 拦截器统一提示
  } finally {
    orderSubmitting.value = false;
  }
}

/** 确认订单：draft → confirmed（后端写确认时间；重复操作 409 由拦截器提示） */
async function confirmOrder(): Promise<void> {
  if (!orderInfo.value || orderConfirming.value) return;
  orderConfirming.value = true;
  try {
    orderInfo.value = await orderApi.confirm(orderInfo.value.id);
    ElMessage.success('订单已确认');
  } catch {
    // 错误由 http 拦截器统一提示
  } finally {
    orderConfirming.value = false;
  }
}

// —— 草稿工作区（正文/当前任务与草稿面板双向；备注只读下发） ——
const draftText = ref('');
const draftNotes = ref('');
const currentTaskId = ref<string | null>(null);
const generating = ref(false);

// 子面板引用：对应动作提交成功后关闭其对话框
const aiPanelRef = ref<InstanceType<typeof LeadAiPanel> | null>(null);
const draftPanelRef = ref<InstanceType<typeof LeadDraftPanel> | null>(null);
const actionPanelRef = ref<InstanceType<typeof LeadActionPanel> | null>(null);

/** 阶段合法后继（与后端 LEAD_STAGE_TRANSITIONS 对齐；仅前端体验，后端为准） */
const STAGE_TRANSITIONS: Record<string, string[]> = {
  new: ['contacted'],
  contacted: ['communicating'],
  communicating: ['quoted', 'visit_booked'],
  quoted: ['communicating', 'visit_booked'],
  visit_booked: ['visit_done', 'communicating'],
  visit_done: ['quoted'],
};

const stageOptions = computed(() =>
  (lead.value ? (STAGE_TRANSITIONS[lead.value.stage] ?? []) : []).map((s) => ({
    value: s,
    label: STAGE_LABELS[s] ?? s,
  })),
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [detail, evts, sum, draftList, intentProposal] = await Promise.all([
      leadsApi.getDetail(leadId),
      leadsApi.events(leadId),
      leadsApi.aiSummary(leadId).catch(() => null),
      leadsApi.listDrafts(leadId).catch(() => [] as DraftItem[]),
      leadsApi.intentProposals(leadId).catch(() => null),
    ]);
    lead.value = detail;
    events.value = evts;
    // 订单确认单仅已成交客资查询（后端创建前置 finalStatus=won；加载失败不阻断整页）
    if (detail.finalStatus === 'won') void loadOrderInfo();
    if (sum) {
      summaryStatus.value = sum.status;
      summary.value = sum.summary;
    }
    drafts.value = draftList;
    if (intentProposal) {
      proposalStatus.value = intentProposal.status;
      proposal.value = intentProposal.proposal;
    }
    // 预填最新草稿文本到编辑框
    if (draftList.length > 0) {
      draftText.value = draftList[0].text;
      currentTaskId.value = draftList[0].taskId;
    }
  } catch {
    // 错误由 http 拦截器统一弹出
  } finally {
    loading.value = false;
    scheduleAiPolling();
  }
}

// —— AI 建议轮询（2026-08-26 O8 评测缺口）：任务 8~20 秒完成，登记后立即打开详情页
// 不再定格在「暂无」——只要还有在途建议就 5s 轮询，双双落定或达上限即停（LeadsQueueView 同款裸 interval 模式）。
const AI_POLL_INTERVAL_MS = 5000;
const AI_POLL_MAX_TICKS = 18; // ~90 秒（任务 deadline 120s 内留观察余量）
let aiPollTimer: ReturnType<typeof setInterval> | null = null;
let aiPollTicks = 0;

function stopAiPolling(): void {
  if (aiPollTimer !== null) {
    clearInterval(aiPollTimer);
    aiPollTimer = null;
  }
  aiPollTicks = 0;
}

function scheduleAiPolling(): void {
  const pending = summaryStatus.value === 'pending' || proposalStatus.value === 'pending';
  if (!pending || aiPollTimer !== null) return;
  aiPollTimer = setInterval(() => {
    aiPollTicks += 1;
    if (aiPollTicks > AI_POLL_MAX_TICKS) {
      stopAiPolling();
      return;
    }
    void refreshAi();
  }, AI_POLL_INTERVAL_MS);
}

async function refreshAi(): Promise<void> {
  const [sum, prop] = await Promise.all([
    leadsApi.aiSummary(leadId).catch(() => null),
    leadsApi.intentProposals(leadId).catch(() => null),
  ]);
  if (sum) {
    summaryStatus.value = sum.status;
    summary.value = sum.summary;
  }
  if (prop) {
    proposalStatus.value = prop.status;
    proposal.value = prop.proposal;
  }
  if (summaryStatus.value !== 'pending' && proposalStatus.value !== 'pending') stopAiPolling();
}

/** 手动重提摘要（degraded/none 一键重试，非终态幂等） */
async function regenerateSummary(): Promise<void> {
  if (regenSubmitting.value) return;
  regenSubmitting.value = true;
  try {
    await leadsApi.summaryRegenerate(leadId);
    ElMessage.success('已重新提交 AI 摘要，约 10~20 秒后自动刷新');
    summaryStatus.value = 'pending';
    stopAiPolling();
    scheduleAiPolling();
  } catch {
    // 错误由拦截器提示
  } finally {
    regenSubmitting.value = false;
  }
}

/** 手动生成分级建议（空态一键触发，POST /leads/:id/classify） */
async function generateProposal(): Promise<void> {
  if (classifySubmitting.value) return;
  classifySubmitting.value = true;
  try {
    await leadsApi.classifySubmit(leadId);
    ElMessage.success('已提交意向分级，约 10~20 秒后自动刷新');
    proposalStatus.value = 'pending';
    stopAiPolling();
    scheduleAiPolling();
  } catch {
    // 错误由拦截器提示
  } finally {
    classifySubmitting.value = false;
  }
}

async function loadDrafts(): Promise<void> {
  drafts.value = await leadsApi.listDrafts(leadId);
  if (drafts.value.length > 0) {
    draftText.value = drafts.value[0].text;
    currentTaskId.value = drafts.value[0].taskId;
  }
}

async function generateDraft(goal: string): Promise<void> {
  generating.value = true;
  try {
    const view = await leadsApi.createDraft(leadId, {
      goal: goal.trim() || undefined,
    });
    currentTaskId.value = view.taskId;
    if (view.message) {
      draftText.value = view.message;
      draftNotes.value = view.notes ?? '';
    }
    await loadDrafts();
  } catch {
    // 错误由拦截器提示
  } finally {
    generating.value = false;
  }
}

async function saveEdit(): Promise<void> {
  if (!currentTaskId.value || !draftText.value.trim()) return;
  try {
    await leadsApi.patchDraft(leadId, currentTaskId.value, draftText.value.trim());
    await loadDrafts();
  } catch {
    // 错误由拦截器提示
  }
}

/** 一键复制：navigator.clipboard 成功后才调 copy 端点；失败不记录 copied（无复制证据不记） */
async function onCopy(): Promise<void> {
  const text = draftText.value.trim();
  if (!text) return;
  const clipboard = navigator.clipboard;
  if (!clipboard?.writeText) {
    ElMessage.warning('当前浏览器不支持自动复制，请手动选择文本复制');
    return;
  }
  try {
    await clipboard.writeText(text);
  } catch {
    ElMessage.error('复制失败，请检查浏览器剪贴板权限');
    return;
  }
  if (!currentTaskId.value) {
    ElMessage.warning('当前草稿尚未关联任务，无法记录复制状态');
    return;
  }
  try {
    await leadsApi.copyDraft(leadId, currentTaskId.value);
    await loadDrafts();
  } catch {
    // 错误由拦截器提示
  }
}

async function submitSendRecord(evidence: string): Promise<void> {
  if (!currentTaskId.value) return;
  try {
    await leadsApi.sendRecord(leadId, currentTaskId.value, evidence);
    draftPanelRef.value?.closeSendDialog();
    await load();
  } catch {
    // 错误由拦截器提示
  }
}

async function submitStage(payload: { stage: string; reason: string }): Promise<void> {
  try {
    await leadsApi.transitionStage(leadId, payload);
    actionPanelRef.value?.closeStageDialog();
    await load();
  } catch {
    // 错误由拦截器提示
  }
}

/** 标记成交（2026-08-28 bug3）：成交价落库后复盘「成交额/均单」即有数据源 */
async function submitWon(payload: { amountFen: number; reason: string }): Promise<void> {
  try {
    await leadsApi.won(leadId, payload);
    ElMessage.success('已标记成交——复盘成交额将计入本单');
    aiPanelRef.value?.closeIntentDialog();
    actionPanelRef.value?.closeWonDialog();
    await load();
  } catch {
    // 错误由拦截器提示
  }
}

async function submitChurn(payload: { reason: string; note?: string }): Promise<void> {
  try {
    await leadsApi.proposeChurn(leadId, payload);
    actionPanelRef.value?.closeChurnDialog();
    await load();
  } catch {
    // 错误由拦截器提示
  }
}

async function submitFollowUp(payload: FollowUpPayload): Promise<void> {
  try {
    await leadsApi.recordFollowUp(leadId, payload);
    actionPanelRef.value?.closeFollowDialog();
    await load();
  } catch {
    // 错误由拦截器提示
  }
}

async function submitSummaryFeedback(decision: string, note?: string): Promise<void> {
  if (feedbackSubmitting.value) return;
  feedbackSubmitting.value = true;
  try {
    await leadsApi.summaryFeedback(leadId, { decision, ...(note ? { note } : {}) });
    const label =
      decision === 'adopted' ? '已采用' : decision === 'modified' ? '已记录修改说明' : '已拒绝';
    ElMessage.success(`AI 摘要反馈：${label}`);
    if (decision === 'modified') aiPanelRef.value?.closeModifyDialog();
    await load();
  } catch {
    // 错误由拦截器提示
  } finally {
    feedbackSubmitting.value = false;
  }
}

/** 登记首次触达（SLA 止表唯一入口，2026-08-25 补 UI：此前后端端点无前端按钮） */
async function markContactAttempt(): Promise<void> {
  if (contactSubmitting.value) return;
  contactSubmitting.value = true;
  try {
    await ElMessageBox.confirm('确认已对客户发起首次人工触达（电话/微信）？', '登记首次触达', {
      type: 'info',
      confirmButtonText: '确认触达',
      cancelButtonText: '取消',
    });
  } catch {
    contactSubmitting.value = false;
    return;
  }
  try {
    await leadsApi.contactAttempt(leadId);
    ElMessage.success('已登记首次触达，SLA 计时结束');
    await load();
  } catch {
    // 错误由拦截器提示
  } finally {
    contactSubmitting.value = false;
  }
}

/** 客户已回复：落 firstCustomerReplyAt（首响时点，复盘口径用） */
async function markCustomerReply(): Promise<void> {
  if (replySubmitting.value) return;
  replySubmitting.value = true;
  try {
    await leadsApi.customerReply(leadId);
    ElMessage.success('已记录客户首次回复');
    await load();
  } catch {
    // 错误由拦截器提示
  } finally {
    replySubmitting.value = false;
  }
}

/** 确认 AI 建议等级（不改判）：沿用分级建议落 intentLevel。 */
async function confirmIntent(): Promise<void> {
  if (!proposal.value) return;
  try {
    await leadsApi.intentConfirm(leadId, { taskId: proposal.value.taskId });
    await load();
  } catch {
    // 错误由拦截器提示
  }
}

/** 改判并确认：提交人工等级＋理由（与 AI 建议不一致时后端记录 aiLevel/humanLevel 留痕）。 */
async function submitIntentOverride(payload: { level: string; reason?: string }): Promise<void> {
  if (!proposal.value) return;
  try {
    await leadsApi.intentConfirm(leadId, {
      taskId: proposal.value.taskId,
      level: payload.level,
      reason: payload.reason,
    });
    aiPanelRef.value?.closeIntentDialog();
    await load();
  } catch {
    // 错误由拦截器提示
  }
}

onMounted(() => {
  void load();
});
onUnmounted(stopAiPolling);
</script>

<template>
  <div v-loading="loading" class="lead-detail wg-page">
    <PageHeader
      :title="lead?.leadNo ?? '客资详情'"
      :sub="
        lead
          ? `${lead.customerName ?? '未确认'} · ${STAGE_LABELS[lead.stage] ?? lead.stage}`
          : undefined
      "
    />
    <div class="lead-detail__cols">
      <!-- 左：只读信息区——客资字段卡＋SLA、时间线（lead_events 倒序） -->
      <div class="lead-detail__info">
        <LeadFieldCard :lead="lead" />
        <div v-if="canEdit" class="lead-detail__profile-edit">
          <el-button size="small" @click="openProfileDialog">编辑画像</el-button>
        </div>
        <LeadTimelineCard :events="events" />
      </div>
      <!-- 右：工作区——作业动作置顶（高频操作零滚动直达）、草稿工作区、AI 摘要＋意向分级 -->
      <div class="lead-detail__work">
        <LeadActionPanel
          ref="actionPanelRef"
          :can-edit="canEdit"
          :contact-submitting="contactSubmitting"
          :reply-submitting="replySubmitting"
          :contacted="Boolean(lead?.firstContactAttemptAt)"
          :customer-replied="Boolean(lead?.firstCustomerReplyAt)"
          :stage-options="stageOptions"
          @stage="submitStage"
          @won="submitWon"
          @churn="submitChurn"
          @followup="submitFollowUp"
          @contact-attempt="markContactAttempt"
          @customer-reply="markCustomerReply"
        />
        <!-- 订单确认（批次1 Task 8）：仅已成交客资显示（finalStatus=won，与后端创建前置一致）；
             无单显示创建表单，有单显示快照+状态；金额按元展示（分÷100） -->
        <section v-if="lead?.finalStatus === 'won'" class="wg-card order-card">
          <h3 class="wg-card-title order-card__title">
            订单确认
            <el-tag
              v-if="orderInfo"
              :type="orderInfo.status === 'confirmed' ? 'success' : 'warning'"
              size="small"
            >
              {{ orderInfo.status === 'confirmed' ? '已确认' : '待确认' }}
            </el-tag>
          </h3>
          <!-- 有单：只读快照（金额分÷100 按元显示） -->
          <template v-if="orderInfo">
            <p class="order-card__field">
              <span class="order-card__label">产品/服务范围</span>{{ orderInfo.products }}
            </p>
            <p class="order-card__field order-card__pre">
              <span class="order-card__label">报价快照</span>{{ orderInfo.quoteSnapshot }}
            </p>
            <p class="order-card__field">
              <span class="order-card__label">优惠说明</span>{{ orderInfo.discountNote ?? '—' }}
            </p>
            <p class="order-card__field">
              <span class="order-card__label">定金（元）</span>{{ fenToYuan(orderInfo.depositFen) }}
            </p>
            <p class="order-card__field">
              <span class="order-card__label">尾款（元）</span>{{ fenToYuan(orderInfo.balanceFen) }}
            </p>
            <p class="order-card__field">
              <span class="order-card__label">材料成本（元）</span
              >{{ orderInfo.materialCostFen === null ? '—' : fenToYuan(orderInfo.materialCostFen) }}
            </p>
            <p class="order-card__field">
              <span class="order-card__label">付款方式</span
              >{{ PAY_METHOD_LABELS[orderInfo.payMethod ?? ''] ?? '—' }}
            </p>
            <p class="order-card__field">
              <span class="order-card__label">创建时间</span>{{ fmt(orderInfo.createdAt) }}
            </p>
            <p v-if="orderInfo.status === 'confirmed'" class="order-card__field">
              <span class="order-card__label">确认时间</span
              >{{ fmt(orderInfo.customerConfirmedAt) }}
            </p>
            <el-button
              v-if="orderInfo.status === 'draft' && canEdit"
              type="primary"
              round
              :loading="orderConfirming"
              class="order-card__confirm"
              data-testid="order-confirm-btn"
              @click="confirmOrder"
            >
              确认订单
            </el-button>
          </template>
          <!-- 无单：创建表单（元输入 ×100 转分提交；提交按钮仅 m03:edit 可见） -->
          <el-form v-else label-width="96px" class="order-card__form">
            <el-form-item label="产品/服务范围" required>
              <el-input
                v-model="orderForm.products"
                type="textarea"
                :rows="2"
                maxlength="1000"
                placeholder="如：演示品牌 DM04 前挡 + DM13 侧后挡"
                data-testid="order-products"
              />
            </el-form-item>
            <el-form-item label="报价快照" required>
              <el-input
                v-model="orderForm.quoteSnapshot"
                type="textarea"
                :rows="3"
                maxlength="2000"
                placeholder="支持多行：逐项报价与金额、合计"
                data-testid="order-quote"
              />
            </el-form-item>
            <el-form-item label="优惠说明">
              <el-input
                v-model="orderForm.discountNote"
                type="textarea"
                :rows="2"
                maxlength="1000"
                placeholder="选填：优惠原因与金额"
                data-testid="order-discount"
              />
            </el-form-item>
            <el-form-item label="定金（元）">
              <el-input-number
                v-model="orderForm.depositYuan"
                :min="0"
                :max="10000000"
                :step="100"
                data-testid="order-deposit"
                style="width: 100%"
              />
            </el-form-item>
            <el-form-item label="尾款（元）">
              <el-input-number
                v-model="orderForm.balanceYuan"
                :min="0"
                :max="10000000"
                :step="100"
                data-testid="order-balance"
                style="width: 100%"
              />
            </el-form-item>
            <!-- 材料成本（批次4）：选填，留空=未录成本（毛利口径不计入） -->
            <el-form-item label="材料成本（元）">
              <el-input-number
                v-model="orderForm.materialCostYuan"
                :min="0"
                :max="10000000"
                :step="100"
                data-testid="order-material-cost"
                style="width: 100%"
              />
            </el-form-item>
            <el-form-item label="付款方式">
              <el-select
                v-model="orderForm.payMethod"
                placeholder="请选择付款方式"
                clearable
                data-testid="order-pay-method"
                style="width: 100%"
              >
                <el-option
                  v-for="opt in PAY_METHOD_OPTIONS"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
            </el-form-item>
            <el-button
              v-if="canEdit"
              type="primary"
              round
              :loading="orderSubmitting"
              :disabled="!orderForm.products.trim() || !orderForm.quoteSnapshot.trim()"
              data-testid="order-submit"
              @click="submitOrder"
            >
              提交确认单
            </el-button>
          </el-form>
        </section>
        <LeadDraftPanel
          ref="draftPanelRef"
          v-model:text="draftText"
          v-model:task-id="currentTaskId"
          :can-edit="canEdit"
          :generating="generating"
          :drafts="drafts"
          :notes="draftNotes"
          @generate="generateDraft"
          @copy="onCopy"
          @save="saveEdit"
          @send="submitSendRecord"
        />
        <LeadAiPanel
          ref="aiPanelRef"
          :summary="summary"
          :summary-status="summaryStatus"
          :lead="lead"
          :proposal="proposal"
          :proposal-status="proposalStatus"
          :can-edit="canEdit"
          :regen-submitting="regenSubmitting"
          :classify-submitting="classifySubmitting"
          @summary-feedback="submitSummaryFeedback"
          @confirm-intent="confirmIntent"
          @override-intent="submitIntentOverride"
          @regenerate-summary="regenerateSummary"
          @generate-proposal="generateProposal"
        />
      </div>
    </div>

    <el-dialog v-model="profileDialog" title="编辑客户画像" width="440px">
      <el-form label-width="90px">
        <el-form-item label="性别">
          <el-select v-model="profileForm.gender" clearable placeholder="不修改">
            <el-option value="male" label="男" />
            <el-option value="female" label="女" />
          </el-select>
        </el-form-item>
        <el-form-item label="年龄段">
          <el-select v-model="profileForm.ageBand" clearable placeholder="不修改">
            <el-option
              v-for="v in ['18-25', '26-35', '36-45', '46-55', '55+']"
              :key="v"
              :value="v"
              :label="v"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="行业"
          ><el-input v-model="profileForm.industry" maxlength="50"
        /></el-form-item>
        <el-form-item label="住所方位"
          ><el-input v-model="profileForm.district" maxlength="50"
        /></el-form-item>
        <el-form-item label="购车门店"
          ><el-input v-model="profileForm.purchaseDealer" maxlength="100"
        /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="profileDialog = false">取消</el-button>
        <el-button type="primary" :loading="profileSaving" @click="submitProfile">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 两栏读写分区（V2.5 令牌）：hairline 白卡 18px 由子面板 wg-card 承担。
 * 左栏只读信息自适应，右栏工作区固定 420px（草稿编辑不再挤在窄栏）；
 * 窄屏（<1100px）折叠为单列，工作区在前、信息区在后，保证高频操作优先可达。 */
.lead-detail__cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 420px;
  gap: 16px;
  align-items: start;
}
.lead-detail__info,
.lead-detail__work {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
@media (max-width: 1099px) {
  .lead-detail__cols {
    grid-template-columns: 1fr;
  }
  .lead-detail__work {
    order: -1;
  }
}

/* 订单确认卡（批次1 Task 8）：字段行排版同客资字段卡；报价快照保留多行换行 */
.order-card__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 17px;
  margin-bottom: 12px;
}
.order-card__field {
  margin: 4px 0;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-all;
}
.order-card__label {
  display: inline-block;
  min-width: 84px;
  color: var(--wg-ink-muted);
}
.order-card__pre {
  white-space: pre-wrap;
}
.order-card__confirm {
  margin-top: 12px;
}
.order-card__form {
  margin-top: 4px;
}
.lead-detail__profile-edit {
  margin: -4px 0 8px;
}
</style>
