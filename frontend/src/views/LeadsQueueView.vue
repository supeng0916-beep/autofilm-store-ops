<script setup lang="ts">
/* global setInterval, clearInterval */
// 客资队列（P3-03）：筛选条＋表格＋SLA 倒计时（≤10 分钟红色）＋60s 轮询。
// 倒计时按 sla.dueInMinutes 静态渲染（不精确秒级，D-P3-5）；未分配行高亮（row-class-name）。
// 详情按钮是 Task 9 详情页入口（当前跳 /leads/:id，详情路由由 Task 9 落地）。
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { leadsApi, type Lead, type LeadSla } from '../api/leads';
import ManualLeadDialog from '../components/lead/ManualLeadDialog.vue';
import EmptyState from '../components/ui/EmptyState.vue';
import FilterBar from '../components/ui/FilterBar.vue';
import WgHint from '../components/ui/WgHint.vue';
import WgHintIcon from '../components/ui/WgHintIcon.vue';
import PageHeader from '../components/ui/PageHeader.vue';
import { usePermission } from '../composables/usePermission';

const router = useRouter();
const { can } = usePermission();

const leads = ref<Lead[]>([]);
const loading = ref(false);
const manualVisible = ref(false);

const stage = ref('');
const finalStatus = ref('');
const owner = ref('');
const keyword = ref('');

const STAGE_LABELS: Record<string, string> = {
  new: '新线索',
  contacted: '已触达',
  communicating: '沟通中',
  quoted: '已报价',
  visit_booked: '已预约到店',
  visit_done: '已到店',
};

type TagType = 'primary' | 'success' | 'warning' | 'info' | 'danger';

const STAGE_TAG_TYPES: Record<string, TagType> = {
  new: 'info',
  contacted: 'primary',
  communicating: 'success',
  quoted: 'warning',
  visit_booked: 'warning',
  visit_done: 'success',
};

const FINAL_STATUS_LABELS: Record<string, string> = {
  active: '在跟',
  silence: '沉默',
  lost_pending: '待流失',
  lost: '流失',
  won: '成交',
  invalid: '无效',
};

const INTENT_LABELS: Record<string, string> = {
  high: '高',
  mid: '中',
  low: '低',
  pending: '待定',
};

function slaText(sla: LeadSla | undefined): string {
  if (!sla) return '—';
  if (sla.state === 'done') return '已触达';
  if (sla.state === 'na') return '—';
  if (sla.state === 'breach') return '已违约';
  if (sla.state === 'escalate') return '已升级';
  return `${sla.dueInMinutes ?? 0} 分钟`;
}

/** 红色：已违约/已升级，或倒计时 ≤10 分钟（详情 get() 无 sla 时视为不适用，不标红） */
function slaDanger(sla: LeadSla | undefined): boolean {
  if (!sla) return false;
  if (sla.state === 'breach' || sla.state === 'escalate') return true;
  if (sla.state === 'ok' || sla.state === 'remind') return (sla.dueInMinutes ?? 0) <= 10;
  return false;
}

/** 未分配客资行高亮（row-class-name 回调） */
function rowClassName({ row }: { row: Lead }): string {
  return row.ownerUserId ? '' : 'lead-row--unassigned';
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    leads.value = await leadsApi.list({
      stage: stage.value || undefined,
      finalStatus: finalStatus.value || undefined,
      owner: owner.value || undefined,
      keyword: keyword.value || undefined,
    });
  } catch {
    // 错误提示由 http 响应拦截器统一弹出
  } finally {
    loading.value = false;
  }
}

function resetFilters(): void {
  stage.value = '';
  finalStatus.value = '';
  owner.value = '';
  keyword.value = '';
  void load();
}

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 60_000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
  timer = null;
});
</script>

<template>
  <div class="leads-queue wg-page">
    <PageHeader title="客资队列" sub="全店线索跟进与 SLA 首触倒计时">
      <template #actions>
        <WgHintIcon k="queue.card" />
        <WgHint k="queue.manualRegister" placement="bottom">
          <el-button
            v-if="can('m03:edit')"
            round
            data-testid="manual-register-btn"
            @click="manualVisible = true"
            >手工登记</el-button
          >
        </WgHint>
        <el-button v-if="can('m03:edit')" type="primary" round @click="router.push('/leads/import')"
          >导入客资</el-button
        >
      </template>
    </PageHeader>
    <FilterBar>
      <el-select v-model="stage" placeholder="阶段" clearable class="leads-queue__filter">
        <el-option
          v-for="(label, value) in STAGE_LABELS"
          :key="value"
          :label="label"
          :value="value"
        />
      </el-select>
      <el-select v-model="finalStatus" placeholder="最终状态" clearable class="leads-queue__filter">
        <el-option
          v-for="(label, value) in FINAL_STATUS_LABELS"
          :key="value"
          :label="label"
          :value="value"
        />
      </el-select>
      <el-input v-model="owner" placeholder="负责人姓名" clearable class="leads-queue__filter" />
      <el-input
        v-model="keyword"
        placeholder="关键词（编号/称呼/电话/微信）"
        clearable
        class="leads-queue__filter"
      />
      <el-button type="primary" round @click="load">查询</el-button>
      <el-button round @click="resetFilters">重置</el-button>
    </FilterBar>

    <el-table v-loading="loading" :data="leads" :row-class-name="rowClassName" class="wg-table">
      <el-table-column prop="leadNo" label="客资编号" width="160" />
      <el-table-column label="客户称呼" width="120">
        <template #default="{ row }">{{ row.customerName ?? '未确认' }}</template>
      </el-table-column>
      <el-table-column prop="sourcePlatform" label="来源平台" width="120" />
      <el-table-column label="意向" width="80">
        <template #default="{ row }">{{
          INTENT_LABELS[row.intentLevel] ?? row.intentLevel
        }}</template>
      </el-table-column>
      <el-table-column label="阶段" width="120">
        <template #default="{ row }">
          <el-tag :type="STAGE_TAG_TYPES[row.stage] ?? 'info'" size="small">
            {{ STAGE_LABELS[row.stage] ?? row.stage }}
          </el-tag>
        </template>
      </el-table-column>
      <!-- 2026-08-28 bug1：显示负责人姓名（后端 ownerName）；无姓名兜底「未分配」，绝不回退渲染内部 ID -->
      <el-table-column label="负责人" width="140">
        <template #default="{ row }">{{ row.ownerName ?? '未分配' }}</template>
      </el-table-column>
      <el-table-column label="SLA 倒计时" width="120">
        <template #default="{ row }">
          <span :class="slaDanger(row.sla) ? 'lead-sla--danger' : ''">{{ slaText(row.sla) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="下一步" min-width="140">
        <template #default="{ row }">{{ row.nextStep ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="100">
        <template #default="{ row }">
          <el-button link type="primary" @click="router.push(`/leads/${row.id}`)">详情</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <EmptyState desc="暂无客资" />
      </template>
    </el-table>

    <!-- 手工登记（2026-08-25 老板需求）：登记成功即刷新队列 -->
    <ManualLeadDialog v-model="manualVisible" @created="load" />
  </div>
</template>

<style scoped>
.leads-queue__filter {
  width: 160px;
}
/* 未分配行高亮：浅红底（V2.5 令牌，与 SLA 告警同色系） */
:deep(.lead-row--unassigned) {
  background-color: #fdecea;
}
.lead-sla--danger {
  color: var(--wg-danger);
  font-weight: 600;
}
</style>
