<script lang="ts">
/** 驳回理由校验器（Element Plus prompt inputValidator 语义）：
 * ≥5 个非空白字符通过返回 true，否则返回错误提示字符串。 */
export function rejectReasonValidator(value: string): boolean | string {
  return (!!value && value.trim().length >= 5) || '理由至少 5 个字';
}
</script>

<script setup lang="ts">
// 审批中心（P1-05）：状态筛选 + 审批列表 + 批准/驳回（UI 二次确认）/撤回。
// 后端同样要求 approve/reject 载荷含 confirmed:true，前后双保险。
// 权限仅控制渲染（矩阵 §5）：批准/驳回按 approval:decide，撤回按「发起人本人」。
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, ref } from 'vue';

import {
  APPROVAL_STATUS,
  approveApproval,
  listApprovals,
  rejectApproval,
  withdrawApproval,
  type ApprovalItem,
  type ApprovalStatus,
} from '../api/approval';
import EmptyState from '../components/ui/EmptyState.vue';
import FilterBar from '../components/ui/FilterBar.vue';
import WgHint from '../components/ui/WgHint.vue';
import PageHeader from '../components/ui/PageHeader.vue';
import { usePermission } from '../composables/usePermission';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const { can } = usePermission();

const items = ref<ApprovalItem[]>([]);
// 默认只看「待审」：种子基线/历史留痕走筛选器查看，避免淹没真正待办（2026-08-21 门店体验反馈）
const statusFilter = ref<ApprovalStatus | ''>(APPROVAL_STATUS.PENDING);
const loading = ref(false);

const STATUS_OPTIONS: readonly { value: ApprovalStatus | ''; label: string }[] = [
  { value: '', label: '全部' },
  { value: APPROVAL_STATUS.PENDING, label: '待审' },
  { value: APPROVAL_STATUS.APPROVED, label: '已批准' },
  { value: APPROVAL_STATUS.REJECTED, label: '已驳回' },
  { value: APPROVAL_STATUS.WITHDRAWN, label: '已撤回' },
];

const STATUS_LABEL: Record<ApprovalStatus, string> = {
  [APPROVAL_STATUS.PENDING]: '待审',
  [APPROVAL_STATUS.APPROVED]: '已批准',
  [APPROVAL_STATUS.REJECTED]: '已驳回',
  [APPROVAL_STATUS.WITHDRAWN]: '已撤回',
};

/** 状态 pill 色板（wg-tag）：待审蓝/已批准绿/已驳回红/已撤回中性灰 */
const STATUS_TAG_CLASS: Record<ApprovalStatus, string> = {
  [APPROVAL_STATUS.PENDING]: 'info',
  [APPROVAL_STATUS.APPROVED]: 'success',
  [APPROVAL_STATUS.REJECTED]: 'danger',
  [APPROVAL_STATUS.WITHDRAWN]: '',
};

/** 审批类型中文（2026-08-27 老板反馈「类型是乱码」）：内部代码 → 门店可读文案；未知类型回退原值。
 * 2026-08-28 UI 测试 #9：m07.schedule.confirm 误标「预约改期确认」——该类型覆盖新建排期
 * 审批与改期审批两类场景（后端仅此一种类型），改中性「预约排期确认」避免文案混用。 */
const TYPE_LABELS: Record<string, string> = {
  'knowledge.activate': '知识生效',
  'lead.churn': '客资流失确认',
  'm07.schedule.confirm': '预约排期确认',
};
const typeLabel = (type: string): string => TYPE_LABELS[type] ?? type;

/** 审批摘要（2026-08-28 UI 测试 #9 盲批）：payload.summary 由发起方写入完整业务摘要
 * （如「全车隐形车衣+前挡DM04｜08-29 12:00~16:00｜工位 A1」）——数据有、此前 UI 不渲染。
 * 无 summary 的旧审批兜底取 payload.reason/note，再兜底截断 JSON。 */
function payloadSummary(row: ApprovalItem): string {
  const p = row.payload as Record<string, unknown> | null;
  if (!p) return '—';
  const candidate = p.summary ?? p.reason ?? p.note;
  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  const json = JSON.stringify(p);
  return json && json !== '{}' ? (json.length > 60 ? `${json.slice(0, 60)}…` : json) : '—';
}

function statusLabel(status: ApprovalStatus): string {
  return STATUS_LABEL[status] ?? status;
}

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    items.value = await listApprovals(statusFilter.value || undefined);
  } catch {
    // 错误提示由 http 响应拦截器统一弹出
  } finally {
    loading.value = false;
  }
}

/** 批准：ElMessageBox 二次确认 + 后端 confirmed:true 双保险 */
async function onApprove(row: ApprovalItem): Promise<void> {
  try {
    await ElMessageBox.confirm('确认批准该审批？', '二次确认');
  } catch {
    return; // 用户取消，静默
  }
  try {
    await approveApproval(row.id, { confirmed: true });
    ElMessage.success('已批准');
    await refresh();
  } catch {
    // 错误提示由 http 响应拦截器统一弹出
  }
}

/** 驳回：ElMessageBox.prompt 收集理由（≥5字）+ 后端 confirmed:true/reason 校验双保险 */
async function onReject(row: ApprovalItem): Promise<void> {
  let reason: string;
  try {
    const result = await ElMessageBox.prompt('请填写驳回理由（≥5字）', '驳回', {
      inputValidator: rejectReasonValidator,
    });
    // element-plus 将 MessageBoxData 声明为对象与 Action 的交叉类型（不可用）；
    // 运行时 prompt 确认一律 resolve { value, action }，此处做局部断言
    reason = (result as unknown as { value: string }).value;
  } catch {
    return; // 用户取消或校验未通过，静默
  }
  try {
    await rejectApproval(row.id, { confirmed: true, reason });
    ElMessage.success('已驳回');
    await refresh();
  } catch {
    // 错误提示由 http 响应拦截器统一弹出
  }
}

/** 撤回：仅发起人本人可见（渲染过滤），后端仍校验本人 + pending 态 */
async function onWithdraw(row: ApprovalItem): Promise<void> {
  try {
    await withdrawApproval(row.id);
    ElMessage.success('已撤回');
    await refresh();
  } catch {
    // 错误提示由 http 响应拦截器统一弹出
  }
}

onMounted(() => {
  void refresh();
});
</script>

<template>
  <div class="approval-center wg-page">
    <PageHeader title="审批中心" sub="折扣等敏感操作的二次确认与留痕" />
    <FilterBar>
      <el-select
        v-model="statusFilter"
        class="approval-center__filter"
        placeholder="状态筛选"
        @change="refresh"
      >
        <el-option
          v-for="opt in STATUS_OPTIONS"
          :key="opt.value"
          :label="opt.label"
          :value="opt.value"
        />
      </el-select>
    </FilterBar>
    <el-table v-loading="loading" :data="items" class="wg-table">
      <el-table-column label="类型" min-width="130">
        <template #default="{ row }">{{ typeLabel((row as ApprovalItem).type) }}</template>
      </el-table-column>
      <el-table-column label="业务摘要" min-width="240">
        <template #default="{ row }">
          <span class="approval-center__summary" :title="payloadSummary(row as ApprovalItem)">{{
            payloadSummary(row as ApprovalItem)
          }}</span>
        </template>
      </el-table-column>
      <el-table-column label="发起人" min-width="120">
        <template #default="{ row }">{{ (row as ApprovalItem).requesterName ?? '系统' }}</template>
      </el-table-column>
      <el-table-column label="状态" min-width="90">
        <template #default="{ row }">
          <span class="wg-tag" :class="STATUS_TAG_CLASS[(row as ApprovalItem).status]">
            {{ statusLabel((row as ApprovalItem).status) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="createdAt" label="创建时间" min-width="180" />
      <el-table-column prop="decidedAt" label="决定时间" min-width="180" />
      <el-table-column prop="opinion" label="意见" min-width="180" />
      <el-table-column label="操作" min-width="200">
        <template #default="{ row }">
          <template v-if="(row as ApprovalItem).status === APPROVAL_STATUS.PENDING">
            <WgHint k="approval.approve" placement="top">
              <el-button
                v-if="can('approval:decide')"
                size="small"
                round
                type="primary"
                @click="onApprove(row as ApprovalItem)"
              >
                批准
              </el-button>
            </WgHint>
            <WgHint k="approval.reject" placement="top">
              <el-button
                v-if="can('approval:decide')"
                size="small"
                round
                type="danger"
                @click="onReject(row as ApprovalItem)"
              >
                驳回
              </el-button>
            </WgHint>
            <el-button
              v-if="auth.user?.id === (row as ApprovalItem).requesterId"
              size="small"
              round
              @click="onWithdraw(row as ApprovalItem)"
            >
              撤回
            </el-button>
          </template>
        </template>
      </el-table-column>
      <template #empty>
        <EmptyState desc="暂无审批" />
      </template>
    </el-table>
  </div>
</template>

<style scoped>
.approval-center__filter {
  width: 160px;
}
/* 摘要长文本两行封顶（超出省略，悬停 title 看全文），不撑破表格行 */
.approval-center__summary {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--wg-ink-muted);
  word-break: break-all;
}
</style>
