<script setup lang="ts">
// 售后与回访（M09 批次1 + 缺口补齐批次）：回访计划 / 售后受理 / 质保登记 / 转介绍 / 客户评价五页签。
// 红线口径：回访与售后只记录事实，投诉创建会立即通知老板（后端钩子）；
// 质保登记仅记录登记信息，不构成理赔承诺；客户评价 append-only，登记后不可改不可删。
// 写按钮统一 can('m09:edit') 门禁（后端守卫为准）。
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  aftercareApi,
  SR_KIND_LABEL,
  VISIT_PLAN_LABEL,
  type AftercareVisit,
  type CustomerReview,
  type ReferralRecord,
  type ServiceRequest,
  type WarrantyRegistration,
} from '../api/aftercare';
import { workOrderApi, type WorkOrder } from '../api/workOrder';
import EmptyState from '../components/ui/EmptyState.vue';
import PageHeader from '../components/ui/PageHeader.vue';
import WgHintIcon from '../components/ui/WgHintIcon.vue';
import { usePermission } from '../composables/usePermission';
import { useAuthStore } from '../stores/auth';

const { can } = usePermission();
const auth = useAuthStore();

const tab = ref('visits');
const loading = ref(false);
const visits = ref<AftercareVisit[]>([]);
const requests = ref<ServiceRequest[]>([]);
const warranties = ref<WarrantyRegistration[]>([]);
const referrals = ref<ReferralRecord[]>([]);
const reviews = ref<CustomerReview[]>([]);
/** 施工单下拉（新建回访选施工单号）与回访表「施工单」列回显单号 */
const workOrders = ref<WorkOrder[]>([]);
const orderNoOf = (workOrderId: string | null) =>
  workOrderId ? (workOrders.value.find((w) => w.id === workOrderId)?.orderNo ?? workOrderId) : '-';

const fmt = (v: string | null) => (v ? new Date(v).toLocaleString('zh-CN') : '-');
const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString('zh-CN') : '-');

// —— 状态标签/色（与后端 aftercare.states 同口径） ——
const visitStatusLabel: Record<string, string> = {
  pending: '待回访',
  done: '已完成',
  skipped: '已跳过',
};
const visitStatusTag: Record<string, 'primary' | 'success' | 'warning' | 'info' | 'danger'> = {
  pending: 'warning',
  done: 'success',
  skipped: 'info',
};
const srStatusLabel: Record<string, string> = {
  open: '待受理',
  in_progress: '处理中',
  resolved: '已解决',
};
const srStatusTag: Record<string, 'primary' | 'success' | 'warning' | 'info' | 'danger'> = {
  open: 'warning',
  in_progress: 'primary',
  resolved: 'success',
};
const warrantyStatusLabel: Record<string, string> = { pending: '待登记', registered: '已登记' };
const warrantyStatusTag: Record<string, 'primary' | 'success' | 'warning' | 'info' | 'danger'> = {
  pending: 'warning',
  registered: 'success',
};
const referralStatusLabel: Record<string, string> = { pending: '跟进中', won: '已成交' };
const referralStatusTag: Record<string, 'primary' | 'success' | 'warning' | 'info' | 'danger'> = {
  pending: 'warning',
  won: 'success',
};
const SR_KIND_OPTIONS = Object.entries(SR_KIND_LABEL).map(([value, label]) => ({ value, label }));

/** 到期未做行高亮：到期日已过且仍待回访 */
const visitRowClass = ({ row }: { row: AftercareVisit }) =>
  row.status === 'pending' && new Date(row.dueAt).getTime() < Date.now()
    ? 'aftercare__row-overdue'
    : '';

// —— 加载：五列表 + 施工单下拉并行，单列表失败不阻塞其他页签（http 拦截器已 toast） ——
const loadVisits = async () => {
  visits.value = await aftercareApi.visits();
};
const loadRequests = async () => {
  requests.value = await aftercareApi.serviceRequests();
};
const loadWarranties = async () => {
  warranties.value = await aftercareApi.warranties();
};
const loadReferrals = async () => {
  referrals.value = await aftercareApi.referrals();
};
const loadReviews = async () => {
  reviews.value = await aftercareApi.reviews();
};
const loadWorkOrders = async () => {
  try {
    workOrders.value = await workOrderApi.list();
  } catch {
    workOrders.value = []; // 施工单接口失败不阻塞本页：下拉降级为空，回访仍可看
  }
};
const load = async () => {
  loading.value = true;
  try {
    await Promise.allSettled([
      loadVisits(),
      loadRequests(),
      loadWarranties(),
      loadReferrals(),
      loadReviews(),
      loadWorkOrders(),
    ]);
  } finally {
    loading.value = false;
  }
};

// —— 回访计划：标记完成 / 跳过（仅 pending 可操作；跳过留痕问原因） ——
const executeVisit = async (rowArg: unknown) => {
  const row = rowArg as AftercareVisit;
  await aftercareApi.executeVisit(row.id);
  ElMessage.success('已标记完成');
  await loadVisits();
};
const skipVisit = async (rowArg: unknown) => {
  const row = rowArg as AftercareVisit;
  const { value } = await ElMessageBox.prompt('跳过原因（留痕）', '跳过回访', {
    inputPattern: /\S+/,
    inputErrorMessage: '必填',
  });
  await aftercareApi.skipVisit(row.id, value);
  ElMessage.success('已跳过该回访');
  await loadVisits();
};
const visitDialogVisible = ref(false);
const visitSubmitting = ref(false);
const visitForm = ref({ workOrderId: '', dueAt: '' as Date | string, note: '' });
const openVisitDialog = () => {
  visitForm.value = { workOrderId: '', dueAt: '', note: '' };
  visitDialogVisible.value = true;
};
const submitVisit = async () => {
  if (!visitForm.value.workOrderId) {
    ElMessage.error('请选择施工单');
    return;
  }
  const due = new Date(visitForm.value.dueAt);
  if (!visitForm.value.dueAt || Number.isNaN(due.getTime())) {
    ElMessage.error('请选择到期日');
    return;
  }
  visitSubmitting.value = true;
  try {
    await aftercareApi.createVisit({
      workOrderId: visitForm.value.workOrderId,
      dueAt: due.toISOString(),
      ...(visitForm.value.note.trim() ? { note: visitForm.value.note.trim() } : {}),
    });
    ElMessage.success('回访计划已创建（手工创建固定为自定义计划）');
    visitDialogVisible.value = false;
    await loadVisits();
  } catch {
    // http 拦截器已 toast；对话框保留便于修改后重提
  } finally {
    visitSubmitting.value = false;
  }
};

// —— 售后受理：新建（投诉提示立即通知老板）/ 领单 / 标记解决 ——
const srDialogVisible = ref(false);
const srSubmitting = ref(false);
const srForm = ref({ kind: 'consult', content: '' });
const openSrDialog = () => {
  srForm.value = { kind: 'consult', content: '' };
  srDialogVisible.value = true;
};
const submitSr = async () => {
  if (!srForm.value.content.trim()) {
    ElMessage.error('请填写受理内容');
    return;
  }
  srSubmitting.value = true;
  try {
    await aftercareApi.createServiceRequest({
      kind: srForm.value.kind,
      content: srForm.value.content.trim(),
    });
    ElMessage.success(
      srForm.value.kind === 'complaint' ? '投诉已创建，已立即通知老板' : '受理已创建',
    );
    srDialogVisible.value = false;
    await loadRequests();
  } catch {
    // http 拦截器已 toast
  } finally {
    srSubmitting.value = false;
  }
};
/** 领单：置处理中并记本人为处理人（登录态缺失时仅置状态，后端为准） */
const claimRequest = async (rowArg: unknown) => {
  const row = rowArg as ServiceRequest;
  await aftercareApi.updateServiceRequest(row.id, {
    status: 'in_progress',
    ...(auth.user ? { handlerUserId: auth.user.id } : {}),
  });
  ElMessage.success('已领单，进入处理中');
  await loadRequests();
};
const resolveRequest = async (rowArg: unknown) => {
  const row = rowArg as ServiceRequest;
  const { value } = await ElMessageBox.prompt('处理结果（留痕）', '标记解决', {
    inputPattern: /\S+/,
    inputErrorMessage: '必填',
  });
  await aftercareApi.updateServiceRequest(row.id, { status: 'resolved', result: value });
  ElMessage.success('已标记解决');
  await loadRequests();
};

// —— 质保登记：新建（可先占位）/ 登记完成（仅记录登记事实，不构成理赔承诺） ——
const warrantyDialogVisible = ref(false);
const warrantySubmitting = ref(false);
const warrantyForm = ref({
  workOrderId: '',
  customerId: '',
  productModel: '',
  registrationNo: '',
  note: '',
});
const openWarrantyDialog = () => {
  warrantyForm.value = {
    workOrderId: '',
    customerId: '',
    productModel: '',
    registrationNo: '',
    note: '',
  };
  warrantyDialogVisible.value = true;
};
const submitWarranty = async () => {
  const f = warrantyForm.value;
  if (
    !f.workOrderId &&
    !f.customerId.trim() &&
    !f.productModel.trim() &&
    !f.registrationNo.trim()
  ) {
    ElMessage.error('施工单 / 客户 / 产品型号 / 登记编号至少填写一项');
    return;
  }
  warrantySubmitting.value = true;
  try {
    await aftercareApi.createWarranty({
      ...(f.workOrderId ? { workOrderId: f.workOrderId } : {}),
      ...(f.customerId.trim() ? { customerId: f.customerId.trim() } : {}),
      ...(f.productModel.trim() ? { productModel: f.productModel.trim() } : {}),
      ...(f.registrationNo.trim() ? { registrationNo: f.registrationNo.trim() } : {}),
      ...(f.note.trim() ? { note: f.note.trim() } : {}),
    });
    ElMessage.success('质保登记已创建，确认登记完成后点「登记完成」');
    warrantyDialogVisible.value = false;
    await loadWarranties();
  } catch {
    // http 拦截器已 toast
  } finally {
    warrantySubmitting.value = false;
  }
};
const registerWarranty = async (rowArg: unknown) => {
  const row = rowArg as WarrantyRegistration;
  await aftercareApi.registerWarranty(row.id);
  ElMessage.success('已完成登记');
  await loadWarranties();
};

// —— 转介绍：新建（介绍人客户 + 新客资）/ 标记成交 ——
const referralDialogVisible = ref(false);
const referralSubmitting = ref(false);
const referralForm = ref({ referrerCustomerId: '', referredLeadId: '', note: '' });
const openReferralDialog = () => {
  referralForm.value = { referrerCustomerId: '', referredLeadId: '', note: '' };
  referralDialogVisible.value = true;
};
const submitReferral = async () => {
  const f = referralForm.value;
  if (!f.referrerCustomerId.trim()) {
    ElMessage.error('请填写介绍人客户 ID');
    return;
  }
  if (!f.referredLeadId.trim()) {
    ElMessage.error('请填写新客资 ID');
    return;
  }
  referralSubmitting.value = true;
  try {
    await aftercareApi.createReferral({
      referrerCustomerId: f.referrerCustomerId.trim(),
      referredLeadId: f.referredLeadId.trim(),
      ...(f.note.trim() ? { note: f.note.trim() } : {}),
    });
    ElMessage.success('转介绍已登记');
    referralDialogVisible.value = false;
    await loadReferrals();
  } catch {
    // http 拦截器已 toast
  } finally {
    referralSubmitting.value = false;
  }
};
const markReferralWon = async (rowArg: unknown) => {
  const row = rowArg as ReferralRecord;
  await aftercareApi.markReferralWon(row.id);
  ElMessage.success('已标记成交');
  await loadReferrals();
};

// —— 客户评价：新建（评分 1-5 必填，三个载体 ID 与评语选填）；append-only 无编辑/删除 ——
const reviewDialogVisible = ref(false);
const reviewSubmitting = ref(false);
// el-rate 的 modelValue 类型为 number | undefined（RoleplayView 自评同口径）
const reviewForm = ref({
  score: undefined as number | undefined,
  customerId: '',
  leadId: '',
  workOrderId: '',
  content: '',
});
const openReviewDialog = () => {
  reviewForm.value = { score: undefined, customerId: '', leadId: '', workOrderId: '', content: '' };
  reviewDialogVisible.value = true;
};
const submitReview = async () => {
  const f = reviewForm.value;
  if (!f.score || f.score < 1 || f.score > 5) {
    ElMessage.error('请选择评分（1-5 星）');
    return;
  }
  reviewSubmitting.value = true;
  try {
    await aftercareApi.createReview({
      score: f.score,
      ...(f.customerId.trim() ? { customerId: f.customerId.trim() } : {}),
      ...(f.leadId.trim() ? { leadId: f.leadId.trim() } : {}),
      ...(f.workOrderId.trim() ? { workOrderId: f.workOrderId.trim() } : {}),
      ...(f.content.trim() ? { content: f.content.trim() } : {}),
    });
    ElMessage.success('评价已登记（提交后不可修改）');
    reviewDialogVisible.value = false;
    await loadReviews();
  } catch {
    // http 拦截器已 toast；对话框保留便于修改后重提
  } finally {
    reviewSubmitting.value = false;
  }
};

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="aftercare wg-page">
    <PageHeader
      title="售后与回访"
      sub="回访计划 / 售后受理 / 质保登记 / 转介绍 / 客户评价——只记录事实"
    >
      <template #actions>
        <WgHintIcon k="aftercare.card" />
        <el-button round @click="load">刷新</el-button>
      </template>
    </PageHeader>

    <el-tabs v-model="tab" class="aftercare__tabs">
      <!-- 回访计划：到期未做行高亮；交付时系统自动建 7/30 天回访，此处手工补自定义 -->
      <el-tab-pane label="回访计划" name="visits">
        <div class="aftercare__toolbar">
          <el-button
            v-if="can('m09:edit')"
            type="primary"
            size="small"
            round
            @click="openVisitDialog"
            >新建回访</el-button
          >
        </div>
        <el-table
          v-loading="loading"
          :data="visits"
          :row-class-name="visitRowClass"
          class="wg-table"
        >
          <el-table-column label="客户" width="120">
            <template #default="{ row }">{{ row.customerId ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="施工单" min-width="120">
            <template #default="{ row }">{{ orderNoOf(row.workOrderId) }}</template>
          </el-table-column>
          <el-table-column label="计划" width="110">
            <template #default="{ row }">{{ VISIT_PLAN_LABEL[row.plan] ?? row.plan }}</template>
          </el-table-column>
          <el-table-column label="到期日" width="120">
            <template #default="{ row }">{{ fmtDate(row.dueAt) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="visitStatusTag[row.status] ?? 'info'">{{
                visitStatusLabel[row.status] ?? row.status
              }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="can('m09:edit')" label="操作" width="180">
            <template #default="{ row }">
              <template v-if="row.status === 'pending'">
                <el-button size="small" type="primary" round @click="executeVisit(row)"
                  >标记完成</el-button
                >
                <el-button size="small" round @click="skipVisit(row)">跳过</el-button>
              </template>
            </template>
          </el-table-column>
          <template #empty>
            <EmptyState desc="暂无回访计划" />
          </template>
        </el-table>
      </el-tab-pane>

      <!-- 售后受理：投诉创建会立即通知老板（后端钩子），对话框内选投诉时给提示 -->
      <el-tab-pane label="售后受理" name="requests">
        <div class="aftercare__toolbar">
          <el-button v-if="can('m09:edit')" type="primary" size="small" round @click="openSrDialog"
            >新建受理</el-button
          >
        </div>
        <el-table v-loading="loading" :data="requests" class="wg-table">
          <el-table-column label="类型" width="90">
            <template #default="{ row }">{{ SR_KIND_LABEL[row.kind] ?? row.kind }}</template>
          </el-table-column>
          <el-table-column label="内容摘要" min-width="200">
            <template #default="{ row }">{{
              row.content.length > 40 ? `${row.content.slice(0, 40)}…` : row.content
            }}</template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="srStatusTag[row.status] ?? 'info'">{{
                srStatusLabel[row.status] ?? row.status
              }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="处理人" width="120">
            <template #default="{ row }">{{ row.handlerUserId ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="创建时间" width="150">
            <template #default="{ row }">{{ fmt(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column v-if="can('m09:edit')" label="操作" width="180">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'open'"
                size="small"
                type="primary"
                round
                @click="claimRequest(row)"
                >领单</el-button
              >
              <el-button
                v-if="row.status !== 'resolved'"
                size="small"
                round
                @click="resolveRequest(row)"
                >标记解决</el-button
              >
            </template>
          </el-table-column>
          <template #empty>
            <EmptyState desc="暂无售后受理" />
          </template>
        </el-table>
      </el-tab-pane>

      <!-- 质保登记：登记与理赔分开（任务书红线），仅记录登记事实 -->
      <el-tab-pane label="质保登记" name="warranties">
        <div class="aftercare__toolbar">
          <el-button
            v-if="can('m09:edit')"
            type="primary"
            size="small"
            round
            @click="openWarrantyDialog"
            >新建质保登记</el-button
          >
        </div>
        <el-table v-loading="loading" :data="warranties" class="wg-table">
          <el-table-column label="施工单" min-width="120">
            <template #default="{ row }">{{ orderNoOf(row.workOrderId) }}</template>
          </el-table-column>
          <el-table-column label="客户" width="120">
            <template #default="{ row }">{{ row.customerId ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="产品型号" min-width="140">
            <template #default="{ row }">{{ row.productModel ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="登记编号" min-width="140">
            <template #default="{ row }">{{ row.registrationNo ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="登记时间" width="150">
            <template #default="{ row }">{{ fmt(row.registeredAt) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="warrantyStatusTag[row.status] ?? 'info'">{{
                warrantyStatusLabel[row.status] ?? row.status
              }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="can('m09:edit')" label="操作" width="120">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'pending'"
                size="small"
                type="primary"
                round
                @click="registerWarranty(row)"
                >登记完成</el-button
              >
            </template>
          </el-table-column>
          <template #empty>
            <EmptyState desc="暂无质保登记" />
          </template>
        </el-table>
      </el-tab-pane>

      <!-- 转介绍：介绍人客户 → 新客资；新客资成交后人工标成交 -->
      <el-tab-pane label="转介绍" name="referrals">
        <div class="aftercare__toolbar">
          <el-button
            v-if="can('m09:edit')"
            type="primary"
            size="small"
            round
            @click="openReferralDialog"
            >新建转介绍</el-button
          >
        </div>
        <el-table v-loading="loading" :data="referrals" class="wg-table">
          <el-table-column label="介绍人客户" min-width="140">
            <template #default="{ row }">{{ row.referrerCustomerId }}</template>
          </el-table-column>
          <el-table-column label="新客资" min-width="140">
            <template #default="{ row }">{{ row.referredLeadId ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="referralStatusTag[row.status] ?? 'info'">{{
                referralStatusLabel[row.status] ?? row.status
              }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="备注" min-width="160">
            <template #default="{ row }">{{ row.note ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="创建时间" width="150">
            <template #default="{ row }">{{ fmt(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column v-if="can('m09:edit')" label="操作" width="120">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'pending'"
                size="small"
                type="primary"
                round
                @click="markReferralWon(row)"
                >标记成交</el-button
              >
            </template>
          </el-table-column>
          <template #empty>
            <EmptyState desc="暂无转介绍" />
          </template>
        </el-table>
      </el-tab-pane>

      <!-- 客户评价：append-only——登记后不可改不可删（无 PATCH/DELETE 端点） -->
      <el-tab-pane label="客户评价" name="reviews">
        <div class="aftercare__toolbar">
          <el-button
            v-if="can('m09:edit')"
            type="primary"
            size="small"
            round
            @click="openReviewDialog"
            >新建评价</el-button
          >
        </div>
        <el-table v-loading="loading" :data="reviews" class="wg-table">
          <el-table-column label="客户" width="120">
            <template #default="{ row }">{{ row.customerId ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="施工单" min-width="120">
            <template #default="{ row }">{{ orderNoOf(row.workOrderId) }}</template>
          </el-table-column>
          <el-table-column label="评分" width="150">
            <template #default="{ row }">
              <el-rate :model-value="row.score" disabled size="small" />
            </template>
          </el-table-column>
          <el-table-column label="评语" min-width="180">
            <template #default="{ row }">{{ row.content ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="时间" width="150">
            <template #default="{ row }">{{ fmt(row.reviewedAt) }}</template>
          </el-table-column>
          <template #empty>
            <EmptyState desc="暂无客户评价" />
          </template>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- 新建回访（手工创建固定 custom 计划，后端写死） -->
    <el-dialog v-model="visitDialogVisible" title="新建回访计划" width="480px">
      <el-form label-width="90px">
        <el-form-item label="施工单" required>
          <el-select
            v-model="visitForm.workOrderId"
            filterable
            placeholder="选择施工单"
            style="width: 100%"
          >
            <el-option
              v-for="w in workOrders"
              :key="w.id"
              :label="`${w.orderNo}${w.serviceItem ? ` · ${w.serviceItem}` : ''}`"
              :value="w.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="到期日" required>
          <el-date-picker v-model="visitForm.dueAt" type="date" placeholder="选择到期日" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="visitForm.note" placeholder="可选：回访要点" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button round @click="visitDialogVisible = false">取消</el-button>
        <el-button type="primary" round :loading="visitSubmitting" @click="submitVisit"
          >提交</el-button
        >
      </template>
    </el-dialog>

    <!-- 新建售后受理：选投诉时提示将立即通知老板 -->
    <el-dialog v-model="srDialogVisible" title="新建售后受理" width="480px">
      <el-form label-width="90px">
        <el-form-item label="类型" required>
          <el-select v-model="srForm.kind" style="width: 100%">
            <el-option
              v-for="o in SR_KIND_OPTIONS"
              :key="o.value"
              :label="o.label"
              :value="o.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="内容" required>
          <el-input
            v-model="srForm.content"
            type="textarea"
            :rows="3"
            placeholder="受理内容（必填）"
          />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="srForm.kind === 'complaint'"
        type="warning"
        :closable="false"
        show-icon
        title="投诉类型：创建后将立即通知老板"
        class="aftercare__complaint-alert"
      />
      <template #footer>
        <el-button round @click="srDialogVisible = false">取消</el-button>
        <el-button type="primary" round :loading="srSubmitting" @click="submitSr">提交</el-button>
      </template>
    </el-dialog>

    <!-- 新建质保登记：仅记录登记信息，不构成理赔承诺；字段可后补 -->
    <el-dialog v-model="warrantyDialogVisible" title="新建质保登记" width="480px">
      <el-form label-width="90px">
        <el-form-item label="施工单">
          <el-select
            v-model="warrantyForm.workOrderId"
            filterable
            clearable
            placeholder="选择施工单（可选）"
            style="width: 100%"
          >
            <el-option
              v-for="w in workOrders"
              :key="w.id"
              :label="`${w.orderNo}${w.serviceItem ? ` · ${w.serviceItem}` : ''}`"
              :value="w.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="客户">
          <el-input v-model="warrantyForm.customerId" placeholder="客户档案 ID（可选）" />
        </el-form-item>
        <el-form-item label="产品型号">
          <el-input v-model="warrantyForm.productModel" placeholder="如：演示型号 A" />
        </el-form-item>
        <el-form-item label="登记编号">
          <el-input v-model="warrantyForm.registrationNo" placeholder="电子质保登记号（可选）" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="warrantyForm.note" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button round @click="warrantyDialogVisible = false">取消</el-button>
        <el-button type="primary" round :loading="warrantySubmitting" @click="submitWarranty"
          >提交</el-button
        >
      </template>
    </el-dialog>

    <!-- 新建转介绍：介绍人客户 + 新客资 -->
    <el-dialog v-model="referralDialogVisible" title="新建转介绍" width="480px">
      <el-form label-width="90px">
        <el-form-item label="介绍人客户" required>
          <el-input v-model="referralForm.referrerCustomerId" placeholder="介绍人客户档案 ID" />
        </el-form-item>
        <el-form-item label="新客资" required>
          <el-input v-model="referralForm.referredLeadId" placeholder="被转介绍客资 ID" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="referralForm.note" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button round @click="referralDialogVisible = false">取消</el-button>
        <el-button type="primary" round :loading="referralSubmitting" @click="submitReferral"
          >提交</el-button
        >
      </template>
    </el-dialog>

    <!-- 新建客户评价：评分必填（1-5 星），三个载体 ID 与评语选填；提交后不可修改 -->
    <el-dialog v-model="reviewDialogVisible" title="新建客户评价" width="480px">
      <el-form label-width="90px">
        <el-form-item label="评分" required>
          <el-rate v-model="reviewForm.score" />
        </el-form-item>
        <el-form-item label="客户">
          <el-input v-model="reviewForm.customerId" placeholder="客户档案 ID（可选）" />
        </el-form-item>
        <el-form-item label="客资">
          <el-input v-model="reviewForm.leadId" placeholder="客资 ID（可选）" />
        </el-form-item>
        <el-form-item label="施工单">
          <el-input v-model="reviewForm.workOrderId" placeholder="施工单 ID（可选）" />
        </el-form-item>
        <el-form-item label="评语">
          <el-input
            v-model="reviewForm.content"
            type="textarea"
            :rows="3"
            placeholder="可选：客户原话或要点（上限 1000 字）"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button round @click="reviewDialogVisible = false">取消</el-button>
        <el-button type="primary" round :loading="reviewSubmitting" @click="submitReview"
          >提交</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 页签内工具条右对齐（MarketingView 页签内容区同节奏） */
.aftercare__toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 12px;
}
/* 到期未做回访行高亮：浅红底（LeadsQueueView 未分配行同口径） */
:deep(.aftercare__row-overdue) {
  background-color: #fdecea;
}
.aftercare__complaint-alert {
  margin-top: 4px;
}
</style>
