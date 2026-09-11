<script setup lang="ts">
// Agent 任务控制台（V2.2b Task 4）：boss/sys_admin 全局视角——任务列表筛选、详情事件线、
// 失败/降级任务重放、人工接管留痕。权限 ['ai:cost:view','system:manage'] 任一命中（矩阵 §5）；
// 错误提示由 http 拦截器统一弹出；重试/接管 ElMessageBox 二次确认（同 AI 通道开关模式）。
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, ref } from 'vue';

import {
  fetchAiTaskDetail,
  fetchAiTasks,
  retryAiTask,
  takeoverAiTask,
  type AiTask,
  type AiTaskDetail,
  type AiTaskEvent,
  type AiTaskStatus,
} from '../api/aiTasks';
import { fetchAiUsageSummary, type AiUsageSummary } from '../api/ai';

/** 状态中文映射（规格 §5.1 状态机全量） */
const STATUS_LABEL: Record<AiTaskStatus, string> = {
  pending: '排队',
  dispatched: '已派发',
  running: '运行中',
  callback_received: '已回调',
  validated: '已校验',
  done: '成功',
  failed: '失败',
  timeout: '超时',
  degraded: '降级待人工',
  cancelled: '已取消',
};

/** el-tag 语义色：失败族 danger、成功 success、在途 warning、其余 info */
function statusTagType(status: AiTaskStatus): 'danger' | 'success' | 'warning' | 'info' {
  if (status === 'failed' || status === 'degraded' || status === 'timeout') return 'danger';
  if (status === 'done') return 'success';
  if (status === 'running' || status === 'dispatched' || status === 'pending') return 'warning';
  return 'info';
}

function statusLabel(status: string): string {
  return STATUS_LABEL[status as AiTaskStatus] ?? status;
}

/** 技能筛选固定选项（V1 技能面；后端 taskType 为自由串，此处仅作便捷筛选） */
const TASK_TYPE_OPTIONS = [
  'hello',
  'lead.summary',
  'lead.classify',
  'sales.draft_message',
  'knowledge.search',
  'takeover.brief',
  'marketing.video_copy',
  'marketing.competitor_notes',
] as const;

const tasks = ref<AiTask[]>([]);
const loading = ref(false);
const statusFilter = ref('');
const taskTypeFilter = ref('');

async function load(): Promise<void> {
  loading.value = true;
  try {
    tasks.value = await fetchAiTasks({
      status: statusFilter.value ? (statusFilter.value as AiTaskStatus) : undefined,
      taskType: taskTypeFilter.value || undefined,
    });
  } catch {
    // 错误提示由 http 响应拦截器统一弹出
  } finally {
    loading.value = false;
  }
}

/** 输入摘要截断 40 字（全文见详情抽屉） */
function summaryText(task: AiTask): string {
  return task.inputSummary.length > 40 ? `${task.inputSummary.slice(0, 40)}…` : task.inputSummary;
}

/** 耗时秒：finishedAt−createdAt；未结束返回 '-' */
function durationSeconds(task: AiTask): string {
  if (!task.finishedAt) return '-';
  const ms = new Date(task.finishedAt).getTime() - new Date(task.createdAt).getTime();
  return `${(ms / 1000).toFixed(1)} 秒`;
}

/** 成本分转元；未计费返回 '-' */
function costYuan(task: AiTask): string {
  return task.costEstimateFen === null ? '-' : `¥${(task.costEstimateFen / 100).toFixed(2)}`;
}

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('zh-CN') : '-';
}

/** 仅 failed/degraded 可重试（与后端 409 口径一致，前端为体验收敛） */
function retryable(task: AiTask): boolean {
  return task.status === 'failed' || task.status === 'degraded';
}

async function onRetry(task: AiTask): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认重试该「${task.taskType}」任务吗？将以新任务重放（原任务保持不变）。`,
      '重试确认',
    );
  } catch {
    return; // 用户取消，静默
  }
  try {
    const created = await retryAiTask(task.id);
    ElMessage.success(`已重新提交（新任务 ${created.id.slice(0, 8)}…）`);
    await load();
  } catch {
    // 409（状态已变化）等错误由 http 响应拦截器统一弹出
  }
}

async function onTakeover(task: AiTask): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认人工接管该「${task.taskType}」任务吗？接管仅作标记与留痕，不改任务状态。`,
      '接管确认',
    );
  } catch {
    return; // 用户取消，静默
  }
  try {
    await takeoverAiTask(task.id);
    ElMessage.success('已标记人工接管');
    // 详情抽屉正开着该任务时同步事件线
    if (detail.value?.task.id === task.id) await openDetail(task.id);
  } catch {
    // 错误提示由 http 响应拦截器统一弹出
  }
}

// —— 详情抽屉：输入摘要 / 输出 JSON（折叠）/ 错误 / 事件时间线 ——
const drawerVisible = ref(false);
const detail = ref<AiTaskDetail | null>(null);
const detailLoading = ref(false);

async function openDetail(id: string): Promise<void> {
  drawerVisible.value = true;
  detailLoading.value = true;
  try {
    detail.value = await fetchAiTaskDetail(id);
  } catch {
    // 错误提示由 http 响应拦截器统一弹出
  } finally {
    detailLoading.value = false;
  }
}

/** 输出 JSON 美化（折叠面板默认收起，防长输出刷屏） */
function outputJson(task: AiTaskDetail['task']): string {
  return task.output == null ? '（无输出）' : JSON.stringify(task.output, null, 2);
}

/** 决策依据提取（T2 决策留痕）：output 为对象且含非空 reasoning 才返回（有才渲染折叠项） */
function outputReasoning(task: AiTaskDetail['task']): string | null {
  if (!task.output || typeof task.output !== 'object') return null;
  const r = (task.output as { reasoning?: unknown }).reasoning;
  return typeof r === 'string' && r.trim() ? r : null;
}

function eventLabel(event: AiTaskEvent): string {
  const from = event.fromStatus ? statusLabel(event.fromStatus) : '创建';
  return `${from} → ${statusLabel(event.toStatus)}`;
}

// —— 人+AI 协作画像（V1.5 批次3）：按人/按技能/按日三维，ai:cost:view 门控在路由层（同成本段） ——
const usage = ref<AiUsageSummary | null>(null);

async function loadUsage(): Promise<void> {
  usage.value = await fetchAiUsageSummary(30);
}

onMounted(() => {
  void load();
  void loadUsage().catch(() => {
    /* 无 ai:cost:view 时 403 由拦截器提示，画像段显示占位 */
  });
});
</script>

<template>
  <div class="ai-tasks">
    <h2 class="wg-card-title">AI 任务</h2>

    <!-- 人+AI 协作画像（批次3）：30 天窗口三维聚合 -->
    <div v-if="usage" class="wg-card ai-tasks__usage">
      <h3 class="wg-card-title">人 + AI 协作画像（近 30 天）</h3>
      <p class="ai-tasks__usage-total">
        共 {{ usage.total.taskCount }} 次 AI 任务，成本 ¥{{
          (usage.total.costFen / 100).toFixed(2)
        }}
      </p>
      <el-row :gutter="12">
        <el-col :span="12">
          <h4>按人（采纳率 = 采用反馈 / 总反馈）</h4>
          <el-table :data="usage.byUser" size="small" border>
            <el-table-column prop="username" label="账号" width="120" />
            <el-table-column prop="displayName" label="姓名" width="100" />
            <el-table-column prop="taskCount" label="任务" width="64" />
            <el-table-column prop="doneCount" label="成功" width="64" />
            <el-table-column prop="failCount" label="异常" width="64" />
            <el-table-column label="成本" width="80">
              <template #default="{ row }">¥{{ (row.costFen / 100).toFixed(2) }}</template>
            </el-table-column>
            <el-table-column label="采纳率" width="80">
              <template #default="{ row }">
                {{
                  row.feedbackTotal > 0
                    ? Math.round((row.feedbackAdopted / row.feedbackTotal) * 100) + '%'
                    : '—'
                }}
              </template>
            </el-table-column>
          </el-table>
        </el-col>
        <el-col :span="12">
          <h4>按技能</h4>
          <el-table :data="usage.byTaskType" size="small" border>
            <el-table-column prop="taskType" label="技能" min-width="150" />
            <el-table-column prop="count" label="次数" width="70" />
            <el-table-column prop="doneCount" label="成功" width="70" />
            <el-table-column label="成本" width="90">
              <template #default="{ row }">¥{{ (row.costFen / 100).toFixed(2) }}</template>
            </el-table-column>
          </el-table>
          <h4>每日用量</h4>
          <p class="ai-tasks__usage-days">
            <span v-for="d in usage.byDay" :key="d.date" class="ai-tasks__usage-day">
              {{ d.date.slice(5) }}：{{ d.count }} 次
            </span>
          </p>
        </el-col>
      </el-row>
    </div>
    <div class="wg-card">
      <div class="ai-tasks__filters">
        <el-select v-model="statusFilter" clearable placeholder="全部状态" @change="load">
          <el-option
            v-for="(label, status) in STATUS_LABEL"
            :key="status"
            :label="label"
            :value="status"
          />
        </el-select>
        <el-select v-model="taskTypeFilter" clearable placeholder="全部技能" @change="load">
          <el-option v-for="t in TASK_TYPE_OPTIONS" :key="t" :label="t" :value="t" />
        </el-select>
        <el-button @click="load">刷新</el-button>
      </div>

      <el-table v-loading="loading" :data="tasks">
        <el-table-column prop="taskType" label="技能" min-width="170" />
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="statusTagType((row as AiTask).status)" size="small">
              {{ statusLabel((row as AiTask).status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="输入摘要" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">{{ summaryText(row as AiTask) }}</template>
        </el-table-column>
        <el-table-column label="模型" width="140">
          <template #default="{ row }">{{ (row as AiTask).model ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="耗时" width="90">
          <template #default="{ row }">{{ durationSeconds(row as AiTask) }}</template>
        </el-table-column>
        <el-table-column label="成本" width="90">
          <template #default="{ row }">{{ costYuan(row as AiTask) }}</template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">{{ fmt((row as AiTask).createdAt) }}</template>
        </el-table-column>
        <!-- V2.6 布局修复：操作列放宽为 min-width（去 fixed），窄窗口由表格自身横向滚动 -->
        <el-table-column label="操作" min-width="180">
          <template #default="{ row }">
            <el-button size="small" @click="openDetail((row as AiTask).id)">详情</el-button>
            <el-button
              v-if="retryable(row as AiTask)"
              size="small"
              type="primary"
              @click="onRetry(row as AiTask)"
            >
              重试
            </el-button>
            <el-button size="small" type="warning" @click="onTakeover(row as AiTask)">
              接管
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-drawer v-model="drawerVisible" title="任务详情" size="480px">
      <div v-loading="detailLoading" class="ai-tasks__detail">
        <template v-if="detail">
          <h3 class="ai-tasks__section">输入摘要</h3>
          <pre class="ai-tasks__pre">{{ detail.task.inputSummary }}</pre>
          <h3 class="ai-tasks__section">输出</h3>
          <el-collapse>
            <!-- 决策依据（T2 决策留痕）：output.reasoning 有才渲染，默认收起 -->
            <el-collapse-item v-if="outputReasoning(detail.task)" title="决策依据" name="reasoning">
              <p class="ai-tasks__reasoning" data-testid="ai-task-reasoning">
                {{ outputReasoning(detail.task) }}
              </p>
            </el-collapse-item>
            <el-collapse-item title="输出 JSON" name="output">
              <pre class="ai-tasks__pre">{{ outputJson(detail.task) }}</pre>
            </el-collapse-item>
          </el-collapse>
          <p v-if="detail.task.errorMessage" class="ai-tasks__error">
            {{ detail.task.errorMessage }}
          </p>
          <h3 class="ai-tasks__section">事件线</h3>
          <el-timeline>
            <el-timeline-item
              v-for="event in detail.events"
              :key="event.id"
              :timestamp="fmt(event.createdAt)"
            >
              {{ eventLabel(event) }}
              <span v-if="event.reason" class="wg-muted">（{{ event.reason }}）</span>
            </el-timeline-item>
          </el-timeline>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.ai-tasks__filters {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}
.ai-tasks__filters :deep(.el-select) {
  width: 180px;
}
.ai-tasks__detail {
  min-height: 120px;
}
.ai-tasks__section {
  margin: 16px 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--wg-ink);
}
.ai-tasks__pre {
  margin: 0;
  padding: 12px;
  background: var(--wg-canvas);
  border-radius: 8px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
/* 决策依据正文（T2）：默认收起在折叠项内，展开后小字灰底展示 */
.ai-tasks__reasoning {
  margin: 0;
  padding: 8px 12px;
  background: var(--wg-canvas);
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-regular);
  white-space: pre-wrap;
  word-break: break-word;
}
.ai-tasks__error {
  margin: 8px 0;
  color: var(--wg-danger);
  font-size: 13px;
}

/* 协作画像段（批次3） */
.ai-tasks__usage {
  margin-bottom: 12px;
}
.ai-tasks__usage h4 {
  margin: 8px 0 6px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.ai-tasks__usage-total {
  margin: 4px 0 8px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.ai-tasks__usage-days {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.ai-tasks__usage-day {
  padding: 2px 6px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}
</style>
