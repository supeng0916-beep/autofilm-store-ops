<script setup lang="ts">
/* global setInterval, clearInterval, setTimeout, window */
// AI 通道管理（P2-09）：通道状态 + 停止开关（ElMessageBox 二次确认 + PUT confirmed:true）+ 近 7 日成本。
// v1.5 对齐迭代（Task 10）：成本段增预算横幅（进度条/梯度告警色/额度已满提示）+ 老板临时提额 + 成本分解表。
// 路由守卫按 ['system:manage', 'ai:cost:view'] 任一命中放行；页内分段门控（2026-08-13 成本可见性调整，
// 矩阵 AI通道成本行）：开关段仅 system:manage 渲染/可操作；成本段仅 ai:cost:view 渲染。
// 提额按钮按 boss 角色门控（与后端 setDailyOverride 的 boss 硬校验对齐；system:manage 仅 sys_admin 持有，
// 按权限点门控会使 boss 入口不可达、sys_admin 可见却必 403）。
// 纯 ai:cost:view 用户（boss）只见通道状态只读信息与成本段。无权限时段不渲染、对应请求不发起（矩阵 §5）。
// 开关失败回滚 UI；错误提示由 http 响应拦截器统一 toApiMessage 弹出（同审批中心模式）。
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, onUnmounted, ref } from 'vue';

import {
  agentApi,
  type MorningBriefResult,
  type PersonaHint,
  type PersonaMapEntry,
} from '../api/agent';
import {
  fetchAiBudgetStatus,
  fetchAiCostBreakdown,
  fetchAiDailyCosts,
  fetchAiSwitches,
  fetchShadowDraft,
  fetchShadowIntent,
  fetchSkillVersions,
  harvestShadowExperience,
  rollbackSkill,
  setAiDailyBudget,
  setAiSwitch,
  type AiBudgetStatus,
  type AiCostBreakdownRow,
  type AiDailyCost,
  type AiSwitchSnapshot,
  type ShadowDraftSummary,
  type ShadowIntentSummary,
  type SkillVersionRow,
} from '../api/ai';
import {
  pingHealth,
  systemApi,
  fetchHealthInfo,
  downloadDiagnostics,
  type BackupStatus,
  type HealthVersionInfo,
} from '../api/system';
import WgHint from '../components/ui/WgHint.vue';
import WgHintIcon from '../components/ui/WgHintIcon.vue';
import { usePermission } from '../composables/usePermission';
import { useAiStore } from '../stores/ai';
import { useAuthStore } from '../stores/auth';

const ai = useAiStore();
const auth = useAuthStore();
const { can } = usePermission();

/** 提额入口按 boss 角色门控：与后端 setDailyOverride 的 boss 硬校验一致（system:manage 不含 boss） */
const isBoss = computed(() => auth.roles.includes('boss'));

const snapshot = ref<AiSwitchSnapshot | null>(null);
const costs = ref<AiDailyCost[]>([]);
const budgetStatus = ref<AiBudgetStatus | null>(null);
const breakdown = ref<AiCostBreakdownRow[]>([]);
const loading = ref(false);

/** 助手技能包分配（V1.5 批次2）：映射表 + 踩空提示 + 晨报触发（boss∪sys_admin，入口按 boss 门控） */
const personaEntries = ref<PersonaMapEntry[]>([]);
const personaHints = ref<PersonaHint[]>([]);
const briefRunning = ref(false);
const briefResult = ref<MorningBriefResult | null>(null);

const PERSONA_OPTIONS = [
  { value: 'boss', label: '老板助手' },
  { value: 'manager', label: '店长助手' },
  { value: 'sales', label: '销售助手' },
  { value: 'general', label: '门店助手（通用）' },
];

async function loadPersonaMap(): Promise<void> {
  if (!isBoss.value) return;
  try {
    const data = await agentApi.personaMap();
    personaEntries.value = data.entries;
    personaHints.value = data.unmappedMultiRole;
  } catch {
    /* 403 等异常由拦截器提示，区段保持空 */
  }
}

async function onPersonaChange(userId: string, persona: string): Promise<void> {
  await agentApi.setPersonaEntry(userId, persona === '' ? null : persona);
  ElMessage.success('技能包分配已保存');
  await loadPersonaMap();
}

// —— 影子模式（话术对比+意向对比）+ 技能版本回滚（批次5 起，boss∪sys_admin） ——
const shadow = ref<ShadowIntentSummary | null>(null);
const draft = ref<ShadowDraftSummary | null>(null);
const skillVersions = ref<SkillVersionRow[]>([]);
/** 转卡按钮进行中标记（draft:taskId / intent:leadId），同键防重复点击 */
const harvesting = ref<string | null>(null);

async function loadShadowAndVersions(): Promise<void> {
  if (!isBoss.value) return;
  // allSettled 独立兜底：任一数据源失败不连带隐藏其余段（同成本段三路拉取模式）
  const [s, d, v] = await Promise.allSettled([
    fetchShadowIntent(30),
    fetchShadowDraft(30),
    fetchSkillVersions(),
  ]);
  if (s.status === 'fulfilled') shadow.value = s.value;
  if (d.status === 'fulfilled') draft.value = d.value;
  if (v.status === 'fulfilled') skillVersions.value = v.value;
}

/** 话术对比/照发候选样本一键转经验卡（阶段三 B2）：确定性拼卡零 AI 成本，落建议态待老板审批 */
async function onHarvestDraft(taskId: string): Promise<void> {
  const key = `draft:${taskId}`;
  if (harvesting.value) return;
  harvesting.value = key;
  try {
    await harvestShadowExperience({ scope: 'draft', taskId });
    ElMessage.success('已入知识库待老板审批');
  } catch {
    /* 422/403 等由 http 拦截器统一提示 */
  } finally {
    harvesting.value = null;
  }
}

/** 意向改判样本行（表格行类型收窄，同话术段 row 断言口径） */
type IntentSampleRow = ShadowIntentSummary['overrideSamples'][number];

/** 意向改判样本一键转经验卡：AI 判级/人工判级/改判理由三段落卡 */
async function onHarvestIntent(sample: IntentSampleRow): Promise<void> {
  const key = `intent:${sample.leadId}`;
  if (harvesting.value) return;
  harvesting.value = key;
  try {
    await harvestShadowExperience({
      scope: 'intent',
      leadId: sample.leadId,
      aiLevel: sample.aiLevel,
      humanLevel: sample.humanLevel,
      ...(sample.reason ? { reason: sample.reason } : {}),
    });
    ElMessage.success('已入知识库待老板审批');
  } catch {
    /* 由 http 拦截器统一提示 */
  } finally {
    harvesting.value = null;
  }
}

async function onRollback(skillName: string, version: number): Promise<void> {
  await ElMessageBox.confirm(
    `将 ${skillName} 回滚到 v${version}（网关热加载即时生效，新任务记录新版本号），确定？`,
    '一键回滚',
    { type: 'warning' },
  );
  await rollbackSkill(skillName, version);
  ElMessage.success(`已回滚 ${skillName} → v${version}`);
  await loadShadowAndVersions();
}

async function onRunBrief(): Promise<void> {
  briefRunning.value = true;
  briefResult.value = null;
  try {
    briefResult.value = await agentApi.runMorningBrief();
    ElMessage.success(
      briefResult.value.generated ? '晨报已生成并推送' : '今日晨报已生成过，展示既有内容',
    );
  } finally {
    briefRunning.value = false;
  }
}

/** 提额输入范围（元）：与后端 SetDailyBudgetDto budgetFen∈[100, 10_000_000] 分对齐，前端先挡避免 422 往返 */
const RAISE_MIN_YUAN = 1;
const RAISE_MAX_YUAN = 100000;

/** 开关切换目标（scope 联合类型；前端禁用 enum） */
interface SwitchTarget {
  scope: 'global' | 'skill';
  taskType?: string;
  label: string;
}

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    // 开关快照仅 system:manage 段需要：无该权限不请求（避免 403 提示噪音）；通道状态全员可见
    const [sw] = await Promise.all([
      can('system:manage') ? fetchAiSwitches() : Promise.resolve(null),
      ai.refresh(),
    ]);
    snapshot.value = sw;
    if (can('ai:cost:view')) {
      // 成本段三路并行拉取（非 AI 生成类请求，axios 默认超时即可）：日报 + 预算横幅 + 成本分解。
      // allSettled 独立兜底：部分端点失败不连带隐藏其余内容——预算横幅（含「今日 AI 额度已满」
      // 运营告警信号）的可见性不绑定在日报/聚合查询（breakdown）的健康度上；错误提示由 http 拦截器统一弹出。
      const [daily, status, rows] = await Promise.allSettled([
        fetchAiDailyCosts(),
        fetchAiBudgetStatus(),
        fetchAiCostBreakdown(),
      ]);
      if (daily.status === 'fulfilled') costs.value = daily.value;
      if (status.status === 'fulfilled') budgetStatus.value = status.value;
      if (rows.status === 'fulfilled') breakdown.value = rows.value;
    }
  } catch {
    // 错误提示由 http 响应拦截器统一弹出
  } finally {
    loading.value = false;
  }
}

/** 二次确认文案：关闭强调「立即停止提交」（规格 §8），开启简明确认 */
function confirmMessage(label: string, enabled: boolean): string {
  return enabled ? `确认要开启「${label}」吗？` : `确认要关闭「${label}」吗？AI 任务将立即停止提交`;
}

/** 乐观更新本地快照：切换即时可见，失败再回滚 */
function applyEnabled(
  prev: AiSwitchSnapshot,
  target: SwitchTarget,
  enabled: boolean,
): AiSwitchSnapshot {
  if (target.scope === 'global') return { ...prev, global: enabled };
  return {
    ...prev,
    skills: prev.skills.map((s) => (s.taskType === target.taskType ? { ...s, enabled } : s)),
  };
}

/** 切换开关：确认 → 乐观更新 → PUT（api 层补 confirmed:true）→ 失败回滚 UI */
async function toggleSwitch(target: SwitchTarget, enabled: boolean): Promise<void> {
  try {
    await ElMessageBox.confirm(confirmMessage(target.label, enabled), '二次确认');
  } catch {
    return; // 用户取消，静默（尚未改动 UI，无需回滚）
  }
  const prev = snapshot.value;
  if (!prev) return;
  snapshot.value = applyEnabled(prev, target, enabled);
  try {
    snapshot.value = await setAiSwitch({ scope: target.scope, taskType: target.taskType, enabled });
    ElMessage.success('开关已更新');
  } catch {
    snapshot.value = prev; // 失败回滚 UI；错误提示由 http 响应拦截器统一弹出
  }
}

// el-switch change 派发 boolean | string | number；本页只绑定 boolean 型 model-value
function onGlobalChange(value: boolean | string | number): void {
  void toggleSwitch({ scope: 'global', label: 'AI 总开关' }, value === true);
}
function onSkillChange(taskType: string, value: boolean | string | number): void {
  void toggleSwitch({ scope: 'skill', taskType, label: `技能 ${taskType}` }, value === true);
}

/** 横幅进度条百分比：spent/budget×100，封顶 100（在途任务可能使 spent 略超 budget）。
 * budgetFen=0 返回 null：预算 0=AI 完全停用（与 submitTask 预算口径一致），不渲染进度条。 */
const budgetPercent = computed<number | null>(() => {
  const s = budgetStatus.value;
  if (!s || s.budgetFen <= 0) return null;
  return Math.min(100, Math.round((s.spentFen / s.budgetFen) * 100));
});

/** 横幅色调：spent≥alertFen 红、≥warnFen 橙、其余正常绿 */
const budgetBannerType = computed<'error' | 'warning' | 'success'>(() => {
  const s = budgetStatus.value;
  if (!s) return 'success';
  if (s.spentFen >= s.alertFen) return 'error';
  if (s.spentFen >= s.warnFen) return 'warning';
  return 'success';
});

/** 横幅文案：额度已满（含预算 0 停用场景）时切换暂停提示，其余展示已用/预算金额（分→元） */
const budgetBannerText = computed<string>(() => {
  const s = budgetStatus.value;
  if (!s) return '';
  if (s.spentFen >= s.budgetFen) return '今日 AI 额度已满，新任务已暂停';
  return `今日已用 ${(s.spentFen / 100).toFixed(2)} 元 / 预算 ${(s.budgetFen / 100).toFixed(2)} 元`;
});

/** 临时提额：prompt 输入元数 → ×100 转分提交 → 成功后刷新横幅 status。
 * 后端 403（非 boss）/422（金额越界）由 http 响应拦截器统一弹错，此处不重复提示。 */
async function promptRaiseBudget(): Promise<void> {
  let yuanInput: string;
  try {
    const result = await ElMessageBox.prompt(
      '请输入新的当日预算（元，仅今日有效，次日自动回落）',
      '临时提额',
      {
        inputPattern: /^\d+(\.\d{1,2})?$/,
        inputErrorMessage: '请输入有效金额（最多两位小数）',
        inputValidator: (value: string) => {
          const yuan = Number(value);
          if (yuan < RAISE_MIN_YUAN || yuan > RAISE_MAX_YUAN) {
            return `金额须在 ${RAISE_MIN_YUAN}～${RAISE_MAX_YUAN} 元之间`;
          }
          return true;
        },
      },
    );
    yuanInput = result.value;
  } catch {
    return; // 用户取消，静默（尚未发起请求）
  }
  try {
    await setAiDailyBudget(Math.round(Number(yuanInput) * 100)); // 元 → 分（round 防浮点误差）
    ElMessage.success('当日预算已更新');
    budgetStatus.value = await fetchAiBudgetStatus(); // 提额成功后刷新横幅
  } catch {
    // 错误提示由 http 响应拦截器统一弹出
  }
}

onMounted(() => {
  void refresh();
  void loadOpsInfo();
  void loadPersonaMap();
  void loadShadowAndVersions();
});

// —— 系统运维：重启服务（2026-08-26 老板需求；boss 门控与后端硬校验对齐） ——
const restarting = ref(false);
const restartStatus = ref('');
let restartTimer: ReturnType<typeof setInterval> | null = null;

function stopRestartPolling(): void {
  if (restartTimer !== null) {
    clearInterval(restartTimer);
    restartTimer = null;
  }
}
onUnmounted(stopRestartPolling);

/** 重启按钮：确认 → 调端点 → 轮询健康检查（先等 down 再等 up，共 ≤150 秒）→ 恢复后整页刷新 */
async function restartServices(): Promise<void> {
  if (restarting.value) return;
  try {
    await ElMessageBox.confirm(
      '将停止并重新启动整套服务（含 AI 网关），期间页面不可用，预计 30~60 秒恢复。确认重启？',
      '重启服务',
      { type: 'warning', confirmButtonText: '确认重启', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  restarting.value = true;
  restartStatus.value = '正在提交重启请求…';
  try {
    await systemApi.restartServices();
  } catch {
    restarting.value = false;
    restartStatus.value = ''; // 错误由拦截器弹出（403 非老板/脚本未配置），等待态文案不残留
    return;
  }
  // down 阶段 ≤30s（脚本 2 秒缓冲后才停服务）→ up 阶段 ≤120s
  const startedAt = Date.now();
  let seenDown = false;
  restartTimer = setInterval(async () => {
    const up = await pingHealth();
    if (up && !seenDown && Date.now() - startedAt < 30_000) return; // 还没停，继续等 down
    if (!up) {
      seenDown = true;
      restartStatus.value = '服务已停止，正在重新启动…';
      return;
    }
    if (!seenDown && Date.now() - startedAt >= 30_000) {
      seenDown = true; // 一直没等到 down（脚本异常），仍给 up 阶段机会
    }
    stopRestartPolling();
    restartStatus.value = '服务已恢复';
    ElMessage.success('服务已恢复，正在刷新页面');
    setTimeout(() => window.location.reload(), 800);
  }, 3000);
  // 总超时兜底：150 秒仍未恢复则放弃自动刷新，提示人工兜底
  setTimeout(() => {
    if (restartTimer !== null) {
      stopRestartPolling();
      restarting.value = false;
      restartStatus.value = '';
      ElMessage.warning('重启超时未恢复——请在文件夹双击「重启.command」人工处理');
    }
  }, 150_000);
}

// —— 运维扩展（2026-08-27）：版本标识 + 手动备份 + 诊断包导出（均 boss） ——
const healthInfo = ref<HealthVersionInfo | null>(null);
const backupStatus = ref<BackupStatus | null>(null);
const backupRunning = ref(false);
const diagExporting = ref(false);

async function loadOpsInfo(): Promise<void> {
  if (!isBoss.value) return;
  healthInfo.value = await fetchHealthInfo();
  backupStatus.value = await systemApi.backupStatus().catch(() => null);
}

/** 手动备份：成功展示文件与耗时；失败交拦截器提示（通知中心也会收到失败通知） */
async function runBackupNow(): Promise<void> {
  if (backupRunning.value) return;
  backupRunning.value = true;
  try {
    const res = await systemApi.runBackup();
    if (res.ok) {
      ElMessage.success(`备份完成（${(res.durationMs / 1000).toFixed(0)} 秒），已通知老板`);
    } else {
      ElMessage.error(`备份失败：${res.error ?? '未知错误'}`);
    }
    backupStatus.value = await systemApi.backupStatus().catch(() => backupStatus.value);
  } catch {
    // 错误由拦截器提示
  } finally {
    backupRunning.value = false;
  }
}

/** 诊断包导出：拉取脱敏诊断 JSON 并落盘下载（发给技术支持远程排障） */
async function exportDiagnostics(): Promise<void> {
  if (diagExporting.value) return;
  diagExporting.value = true;
  try {
    const bundle = await systemApi.diagnostics();
    downloadDiagnostics(bundle);
    ElMessage.success('诊断包已导出（JSON 文件，请发给技术支持）');
  } catch {
    // 错误由拦截器提示
  } finally {
    diagExporting.value = false;
  }
}
</script>

<template>
  <div class="ai-settings">
    <h2 class="ai-settings__title">AI 通道管理</h2>

    <el-card class="ai-settings__section" shadow="never">
      <template #header>通道状态</template>
      <el-descriptions v-if="ai.status" :column="2" border>
        <el-descriptions-item label="健康状态">
          {{ ai.status.healthy ? '健康' : '不健康' }}
        </el-descriptions-item>
        <el-descriptions-item label="全局开关">
          {{ ai.status.globalEnabled ? '已开启' : '已关闭' }}
        </el-descriptions-item>
        <el-descriptions-item label="最近健康时间">
          {{ ai.status.lastHealthyAt ?? '—' }}
        </el-descriptions-item>
        <el-descriptions-item label="最近错误">
          {{ ai.status.lastError ?? '—' }}
        </el-descriptions-item>
      </el-descriptions>
      <p v-else class="ai-settings__placeholder">加载中…</p>
    </el-card>

    <!-- 助手技能包分配段（V1.5 批次2）：boss∪sys_admin 可管，入口按 boss 角色门控（同提额先例） -->
    <el-card v-if="isBoss" class="ai-settings__section" shadow="never">
      <template #header>助手技能包分配</template>
      <el-alert
        v-for="h in personaHints"
        :key="h.userId"
        type="warning"
        :closable="false"
        class="ai-settings__persona-hint"
        :title="`账号 ${h.username}（${h.roles.join('、')}）未指定专属技能包，将按角色兜底`"
        description="在下方为其选择技能包后保存，例如老板娘选「老板助手」"
      />
      <el-table v-if="personaEntries.length" :data="personaEntries" size="small" border>
        <el-table-column prop="username" label="账号" width="160" />
        <el-table-column prop="displayName" label="姓名" width="140" />
        <el-table-column label="技能包">
          <template #default="{ row }">
            <el-select
              :model-value="row.persona"
              size="small"
              style="width: 200px"
              @change="(v: string) => onPersonaChange(row.userId, v)"
            >
              <el-option
                v-for="opt in PERSONA_OPTIONS"
                :key="opt.value"
                :value="opt.value"
                :label="opt.label"
              />
            </el-select>
          </template>
        </el-table-column>
      </el-table>
      <p v-else class="ai-settings__placeholder">
        暂无显式分配——全员按角色自动匹配（老板/老板娘角色→老板助手，店长→店长助手，销售→销售助手）。
        需要为特殊账号（如多角色的老板娘）指定技能包时，请联系管理员调用 /agent/persona-map。
      </p>
      <el-divider />
      <h3 class="ai-settings__subtitle">经营晨报</h3>
      <p class="ai-settings__persona-hint">
        每天早上自动生成并推送（错过开机时段会在启动后补发）。也可手动触发：
      </p>
      <el-button type="primary" :loading="briefRunning" @click="onRunBrief">
        {{ briefRunning ? '生成中…' : '立即生成今日晨报' }}
      </el-button>
      <pre v-if="briefResult?.content" class="ai-settings__brief">{{ briefResult.content }}</pre>
    </el-card>

    <!-- 影子模式与技能版本（批次5 起）：boss∪sys_admin 可管，入口按 boss 角色门控；
         阶段三 B2 增话术对比样本/照发候选一键转经验卡（确定性拼卡零 AI 成本） -->
    <el-card v-if="isBoss" class="ai-settings__section" shadow="never">
      <template #header>影子模式 · 意向对比</template>
      <template v-if="shadow && shadow.total > 0">
        <p class="ai-settings__persona-hint">
          近 {{ shadow.days }} 天人工确认 {{ shadow.total }} 次，AI 判级与老板终判一致
          {{ shadow.agreed }} 次（一致率 {{ Math.round(shadow.agreementRate * 100) }}%）
        </p>
        <el-table v-if="shadow.overrides.length" :data="shadow.overrides" size="small" border>
          <el-table-column prop="aiLevel" label="AI 判级" width="120" />
          <el-table-column prop="humanLevel" label="人工终判" width="120" />
          <el-table-column prop="count" label="次数" width="80" />
        </el-table>
        <el-table
          v-if="shadow.overrideSamples.length"
          :data="shadow.overrideSamples"
          size="small"
          border
        >
          <el-table-column prop="leadNo" label="客资" width="140" />
          <el-table-column prop="aiLevel" label="AI" width="70" />
          <el-table-column prop="humanLevel" label="人工" width="70" />
          <el-table-column prop="reason" label="改判理由" min-width="180" show-overflow-tooltip />
          <el-table-column label="操作" width="110">
            <template #default="{ row }">
              <el-button
                size="small"
                data-testid="harvest-intent-btn"
                :loading="harvesting === `intent:${(row as IntentSampleRow).leadId}`"
                @click="onHarvestIntent(row as IntentSampleRow)"
              >
                转经验卡
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </template>
      <p v-else class="ai-settings__placeholder">
        近 30 天暂无意向确认记录——销售确认 AI 分级建议后，这里会显示「AI
        和老板差多少」的第一份证据。
      </p>

      <el-divider />
      <h3 class="ai-settings__subtitle">话术对比</h3>
      <template v-if="draft && draft.total > 0">
        <p class="ai-settings__persona-hint">
          近 {{ draft.days }} 天实发 {{ draft.total }} 条，平均相似度
          {{ draft.avgSimilarity }}，照发率 {{ Math.round(draft.verbatimRate * 100) }}%
        </p>
        <el-table v-if="draft.samples.length" :data="draft.samples" size="small" border>
          <el-table-column label="相似度" width="80">
            <template #default="{ row }">{{
              (row as ShadowDraftSummary['samples'][number]).similarity
            }}</template>
          </el-table-column>
          <el-table-column prop="original" label="AI 草稿" min-width="180" show-overflow-tooltip />
          <el-table-column prop="actual" label="人工实发" min-width="180" show-overflow-tooltip />
          <el-table-column label="操作" width="110">
            <template #default="{ row }">
              <el-button
                size="small"
                data-testid="harvest-draft-btn"
                :loading="
                  harvesting === `draft:${(row as ShadowDraftSummary['samples'][number]).taskId}`
                "
                @click="onHarvestDraft((row as ShadowDraftSummary['samples'][number]).taskId)"
              >
                转经验卡
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <h3 class="ai-settings__subtitle">照发候选</h3>
        <p class="ai-settings__persona-hint">
          销售原样照发 AI 草稿的样本（无改写）——AI 已经说得够好的话术，一键沉淀为经验卡。
        </p>
        <el-table
          v-if="draft.verbatimCandidates.length"
          :data="draft.verbatimCandidates"
          size="small"
          border
        >
          <el-table-column prop="original" label="照发原文" min-width="240" show-overflow-tooltip />
          <el-table-column label="操作" width="110">
            <template #default="{ row }">
              <el-button
                size="small"
                data-testid="harvest-verbatim-btn"
                :loading="
                  harvesting ===
                  `draft:${(row as ShadowDraftSummary['verbatimCandidates'][number]).taskId}`
                "
                @click="
                  onHarvestDraft((row as ShadowDraftSummary['verbatimCandidates'][number]).taskId)
                "
              >
                转经验卡
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <p v-else class="ai-settings__placeholder">暂无照发样本。</p>
      </template>
      <p v-else class="ai-settings__placeholder">
        近 30 天暂无话术对比样本——销售发送 AI 草稿（改写或照发）后，这里会显示「AI 写的
        和销售实际发的差多少」。
      </p>

      <el-divider />
      <h3 class="ai-settings__subtitle">技能提示词版本</h3>
      <el-table v-if="skillVersions.length" :data="skillVersions" size="small" border>
        <el-table-column prop="taskType" label="任务类型" min-width="160" />
        <el-table-column prop="skillName" label="技能" min-width="150" />
        <el-table-column label="当前版本" width="90">
          <template #default="{ row }">v{{ row.current ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="可回滚快照" min-width="140">
          <template #default="{ row }">
            <el-button
              v-for="v in row.versions"
              :key="v"
              size="small"
              :disabled="v === row.current"
              @click="onRollback(row.skillName, v)"
            >
              v{{ v }}
            </el-button>
            <span v-if="!row.versions.length">—（发布新版本时留快照目录）</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 停止开关段：仅 system:manage 渲染/可操作（2026-08-13 分段门控） -->
    <el-card v-if="can('system:manage')" class="ai-settings__section" shadow="never">
      <template #header>停止开关<WgHintIcon k="settings.switchCard" /></template>
      <div v-if="snapshot" v-loading="loading" class="ai-settings__switches">
        <div class="ai-settings__switch-row">
          <span>AI 总开关</span>
          <el-switch :model-value="snapshot.global" @change="onGlobalChange" />
        </div>
        <div v-for="skill in snapshot.skills" :key="skill.taskType" class="ai-settings__switch-row">
          <span>技能 {{ skill.taskType }}</span>
          <el-switch
            :model-value="skill.enabled"
            @change="
              (value: string | number | boolean) => onSkillChange(skill.taskType, value === true)
            "
          />
        </div>
      </div>
      <p v-else class="ai-settings__placeholder">加载中…</p>
    </el-card>

    <el-card v-if="can('ai:cost:view')" class="ai-settings__section" shadow="never">
      <template #header>近 7 日成本<WgHintIcon k="settings.costCard" /></template>

      <!-- 预算横幅（段首）：进度条 + 已用/预算文案 + 临时提额入口；budgetFen=0（停用口径）不渲染进度条 -->
      <el-alert
        v-if="budgetStatus"
        :type="budgetBannerType"
        :closable="false"
        class="ai-settings__budget-banner"
      >
        <div class="ai-settings__budget-row">
          <span class="ai-settings__budget-text">{{ budgetBannerText }}</span>
          <WgHint k="settings.raiseBudget" placement="bottom">
            <el-button v-if="isBoss" size="small" @click="promptRaiseBudget"> 临时提额 </el-button>
          </WgHint>
        </div>
        <el-progress
          v-if="budgetPercent !== null"
          :percentage="budgetPercent"
          :stroke-width="8"
          class="ai-settings__budget-progress"
        />
      </el-alert>

      <el-table :data="costs">
        <el-table-column prop="date" label="日期" min-width="120" />
        <el-table-column prop="taskCount" label="任务数" min-width="90" />
        <el-table-column prop="tokensIn" label="输入 token" min-width="110" />
        <el-table-column prop="tokensOut" label="输出 token" min-width="110" />
        <el-table-column label="成本(元)" min-width="110">
          <template #default="{ row }">
            {{ ((row as AiDailyCost).costFen / 100).toFixed(2) }}
          </template>
        </el-table-column>
      </el-table>

      <!-- 成本分解：日期×模型×任务类型聚合，看清钱花在哪（v1.5 注意事项 6） -->
      <h3 class="ai-settings__subhead">成本分解</h3>
      <el-table :data="breakdown">
        <el-table-column prop="date" label="日期" min-width="120" />
        <el-table-column prop="model" label="模型" min-width="120" />
        <el-table-column prop="taskType" label="技能" min-width="110" />
        <el-table-column prop="taskCount" label="任务数" min-width="90" />
        <el-table-column label="token(入/出)" min-width="130">
          <template #default="{ row }">
            {{ (row as AiCostBreakdownRow).tokensIn }} / {{ (row as AiCostBreakdownRow).tokensOut }}
          </template>
        </el-table-column>
        <el-table-column label="成本(元)" min-width="110">
          <template #default="{ row }">
            {{ ((row as AiCostBreakdownRow).costFen / 100).toFixed(2) }}
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 系统运维段（2026-08-26）：重启按钮 boss 专属（后端硬校验对齐）；睡眠挂断/异常时的自助恢复入口。
         2026-08-27 补：版本标识/手动备份/诊断包导出（运维批次 A/C/E） -->
    <el-card v-if="isBoss" class="ai-settings__section" shadow="never">
      <template #header>系统运维<WgHintIcon k="settings.opsCard" /></template>
      <el-descriptions
        v-if="healthInfo"
        :column="2"
        border
        size="small"
        class="ai-settings__ops-desc"
      >
        <el-descriptions-item label="版本">
          v{{ healthInfo.version }}（{{ healthInfo.env }}）
        </el-descriptions-item>
        <el-descriptions-item label="构建时间">
          {{ healthInfo.buildTime ? new Date(healthInfo.buildTime).toLocaleString('zh-CN') : '—' }}
        </el-descriptions-item>
        <el-descriptions-item label="每日自动备份">
          {{ backupStatus ? (backupStatus.enabled ? '已开启（每日 03:00）' : '已关闭') : '—' }}
        </el-descriptions-item>
        <el-descriptions-item label="最近备份">
          {{
            backupStatus?.latest
              ? `${new Date(backupStatus.latest.mtime).toLocaleString('zh-CN')}（共 ${backupStatus.count} 份）`
              : backupStatus
                ? '尚未备份'
                : '—'
          }}
        </el-descriptions-item>
      </el-descriptions>
      <div class="ai-settings__ops">
        <WgHint k="settings.restart" placement="top">
          <el-button
            type="warning"
            round
            :loading="restarting"
            data-testid="restart-services-btn"
            @click="restartServices"
          >
            重启服务
          </el-button>
        </WgHint>
        <WgHint k="settings.runBackup" placement="top">
          <el-button
            round
            :loading="backupRunning"
            data-testid="run-backup-btn"
            @click="runBackupNow"
          >
            立即备份
          </el-button>
        </WgHint>
        <WgHint k="settings.diagnostics" placement="top">
          <el-button
            round
            :loading="diagExporting"
            data-testid="export-diagnostics-btn"
            @click="exportDiagnostics"
          >
            导出诊断包
          </el-button>
        </WgHint>
      </div>
      <p class="ai-settings__ops-hint">
        重启：服务卡住/网页打不开时使用（约 30~60
        秒恢复）；平时无需操作，也可双击文件夹里的「重启.command」。 备份：每日 03:00 自动执行（保留
        14 份），也可随时手动备份。
        诊断包：系统异常时导出发给技术支持（内容已脱敏，不含客户明文信息）。
      </p>
      <p v-if="restartStatus" class="ai-settings__ops-status">{{ restartStatus }}</p>
    </el-card>
  </div>
</template>

<style scoped>
.ai-settings__title {
  margin: 0 0 12px;
}
.ai-settings__section {
  margin-bottom: 16px;
}
.ai-settings__switches {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ai-settings__switch-row {
  display: flex;
  align-items: center;
  gap: 16px;
}
.ai-settings__placeholder {
  margin: 0;
  color: var(--el-text-color-secondary);
}
.ai-settings__budget-banner {
  margin-bottom: 12px;
}
.ai-settings__budget-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ai-settings__budget-text {
  font-weight: 600;
}
.ai-settings__budget-progress {
  margin-top: 8px;
}
.ai-settings__subhead {
  margin: 16px 0 8px;
  font-size: 15px;
  font-weight: 600;
}
.ai-settings__ops {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.ai-settings__ops-desc {
  margin-bottom: 4px;
}
.ai-settings__ops-hint {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  flex: 1 1 320px;
}
.ai-settings__ops-status {
  margin: 8px 0 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

/* 助手技能包分配段（V1.5 批次2） */
.ai-settings__persona-hint {
  margin: 8px 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.ai-settings__subtitle {
  margin: 0 0 4px;
  font-size: 15px;
}
.ai-settings__brief {
  margin: 12px 0 0;
  padding: 12px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
