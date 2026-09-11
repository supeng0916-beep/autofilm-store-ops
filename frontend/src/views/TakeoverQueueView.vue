<script setup lang="ts">
// 接管队列（P4-05）：规则引擎识别需老板/店长介入的客资。
// 2026-08-28 UI 测试 #1：此前全页只读——后端 POST /leads/:id/takeover 一直存在但前端无入口，
// 「接管队列」名义存在、闭环缺失。现补「接管」动作（仅老板/店长可见）：三要素表单
// （原因/证据/下一步，与后端 TakeoverLeadDto 同口径）→ 改派自己＋机会标记＋留痕。
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { leadsApi } from '../api/leads';
import { takeoverApi, type TakeoverCandidate } from '../api/takeover';
import EmptyState from '../components/ui/EmptyState.vue';
import PageHeader from '../components/ui/PageHeader.vue';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const auth = useAuthStore();
/** 接管是管理动作（后端仅老板/店长放行）；销售仅有 m05 查看视角，不显示按钮 */
const canTakeover = computed(() => {
  const roles = auth.roles ?? [];
  return roles.includes('boss') || roles.includes('store_manager');
});

const candidates = ref<TakeoverCandidate[]>([]);
const loading = ref(false);

const stageLabel = (s: string) => {
  const map: Record<string, string> = {
    new: '新客资',
    contacted: '待首次触达',
    communicating: '沟通中',
    quoted: '已报价',
    visit_booked: '已预约',
    visit_done: '已到店',
  };
  return map[s] ?? s;
};

const intentLabel = (l: string) => {
  const map: Record<string, string> = {
    high: '高',
    mid: '中',
    low: '低',
    pending: '待判断',
  };
  return map[l] ?? l;
};

const intentTag = (l: string) => {
  if (l === 'high') return 'danger';
  if (l === 'mid') return 'warning';
  return 'info';
};

const reasonLabel = (r: string) => {
  const map: Record<string, string> = {
    high_intent: '高意向',
    reputation_risk: '声誉风险',
    stagnant: '停滞',
    complex_objection: '复杂异议',
    special_price: '特殊价格',
    technician_required: '指定技师',
  };
  return map[r] ?? r;
};

const goDetail = (id: string) => {
  router.push(`/leads/${id}`);
};

const load = async () => {
  loading.value = true;
  try {
    candidates.value = await takeoverApi.getCandidates();
  } finally {
    loading.value = false;
  }
};

// —— 接管动作（2026-08-28 UI 测试 #1 闭环补齐） ——
const takeoverVisible = ref(false);
const takeoverSubmitting = ref(false);
const takeoverTarget = ref<TakeoverCandidate | null>(null);
const takeoverForm = ref({ reason: '', evidence: '', nextAction: '' });

const openTakeover = (row: TakeoverCandidate) => {
  takeoverTarget.value = row;
  takeoverForm.value = { reason: '', evidence: '', nextAction: '' };
  takeoverVisible.value = true;
};

const submitTakeover = async () => {
  const target = takeoverTarget.value;
  if (!target) return;
  const f = takeoverForm.value;
  if (
    f.reason.trim().length < 2 ||
    f.evidence.trim().length < 2 ||
    f.nextAction.trim().length < 2
  ) {
    ElMessage.warning('接管原因、证据、下一步动作均必填（各≥2字）');
    return;
  }
  takeoverSubmitting.value = true;
  try {
    await leadsApi.takeover(target.leadId, {
      reason: f.reason.trim(),
      evidence: f.evidence.trim(),
      nextAction: f.nextAction.trim(),
    });
    ElMessage.success(`已接管 ${target.leadNo}，负责人变为 ${auth.user?.displayName ?? '你'}`);
    takeoverVisible.value = false;
    await load();
  } catch {
    // 错误由 http 拦截器统一弹出
  } finally {
    takeoverSubmitting.value = false;
  }
};

onMounted(load);
</script>

<template>
  <div class="takeover-queue wg-page">
    <PageHeader
      title="接管队列"
      :sub="
        canTakeover
          ? '高意向/停滞等需管理者介入的客资；接管后负责人变为你本人'
          : '高意向/停滞等需管理者介入的客资（接管操作需店长或老板）'
      "
    />
    <el-table v-loading="loading" :data="candidates" border stripe class="wg-table">
      <el-table-column prop="leadNo" label="客资编号" width="140" />
      <el-table-column prop="customerName" label="客户" width="120" />
      <el-table-column prop="sourcePlatform" label="来源" width="80" />
      <el-table-column prop="intentLevel" label="意向" width="80">
        <template #default="{ row }">
          <el-tag :type="intentTag(row.intentLevel)" size="small">{{
            intentLabel(row.intentLevel)
          }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="stage" label="阶段" width="100">
        <template #default="{ row }">{{ stageLabel(row.stage) }}</template>
      </el-table-column>
      <el-table-column label="触发原因" min-width="150">
        <template #default="{ row }">
          <el-tag v-for="r in row.reasons" :key="r" size="small" style="margin-right: 4px">{{
            reasonLabel(r)
          }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="ownerName" label="负责人" width="100" />
      <el-table-column label="操作" width="170">
        <template #default="{ row }">
          <el-button
            size="small"
            round
            type="primary"
            @click="goDetail((row as TakeoverCandidate).leadId)"
            >查看详情</el-button
          >
          <el-button
            v-if="canTakeover"
            size="small"
            round
            type="warning"
            @click="openTakeover(row as TakeoverCandidate)"
            >接管</el-button
          >
        </template>
      </el-table-column>
      <template #empty>
        <EmptyState desc="暂无需要接管的客资" />
      </template>
    </el-table>

    <el-dialog v-model="takeoverVisible" title="接管客资" width="480px">
      <template v-if="takeoverTarget">
        <p class="takeover-queue__meta">
          {{ takeoverTarget.leadNo }} · {{ takeoverTarget.customerName ?? '未确认' }} · 现负责人
          {{ takeoverTarget.ownerName ?? '—' }}
        </p>
        <el-form label-width="90px">
          <el-form-item label="接管原因" required>
            <el-input
              v-model="takeoverForm.reason"
              placeholder="为何需要你亲自接管（≥2字）"
              maxlength="500"
              show-word-limit
            />
          </el-form-item>
          <el-form-item label="接管证据" required>
            <el-input
              v-model="takeoverForm.evidence"
              type="textarea"
              :rows="3"
              placeholder="客户原话/跟进记录等依据（≥2字）"
              maxlength="2000"
              show-word-limit
            />
          </el-form-item>
          <el-form-item label="下一步动作" required>
            <el-input
              v-model="takeoverForm.nextAction"
              placeholder="接管后你准备怎么做（≥2字）"
              maxlength="2000"
              show-word-limit
            />
          </el-form-item>
        </el-form>
        <p class="takeover-queue__tip">
          确认后该客资负责人变为「{{ auth.user?.displayName }}」并全程留痕。
        </p>
      </template>
      <template #footer>
        <el-button round @click="takeoverVisible = false">取消</el-button>
        <el-button type="primary" round :loading="takeoverSubmitting" @click="submitTakeover"
          >确认接管</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.takeover-queue {
  /* V2.6 布局修复：留白统一由 el-main 24px padding 提供 */
  width: 100%;
}
.takeover-queue__meta {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--wg-ink-muted);
}
.takeover-queue__tip {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--wg-ink-muted);
}
</style>
