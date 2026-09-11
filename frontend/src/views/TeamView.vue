<script setup lang="ts">
// 人机团队（V2.4，M08）：技师卡网格（档案+忙闲+四指标+五维雷达）+ Agent 花名册 + 考勤奖惩记录。
// 查看 m08:view（路由守卫拦截）；写按钮显隐用 can('approval:decide')（恰为 boss|store_manager，
// 与后端服务层角色硬校验同集合——近似体验层口径，安全边界在后端）。
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  createRecord,
  createTechnician,
  overview,
  STAFF_RECORD_KIND_LABEL,
  STAFF_RECORD_KIND_TAG,
  TECHNICIAN_SKILL_LABEL,
  TECHNICIAN_SKILL_OPTIONS,
  updateTechnician,
  type AgentRow,
  type StaffRecordKind,
  type StaffRecordRow,
  type TeamOverview,
  type TechnicianCard,
} from '../api/team';
import { usePermission } from '../composables/usePermission';
import TeamRecordDialog from './TeamRecordDialog.vue';
import TeamTechnicianCard from './TeamTechnicianCard.vue';

const { can } = usePermission();
const canManage = computed(() => can('approval:decide'));

const data = ref<TeamOverview | null>(null);
const loading = ref(false);

const load = async () => {
  loading.value = true;
  try {
    data.value = await overview();
  } finally {
    loading.value = false;
  }
};

const fmt = (v: string | null) => (v ? new Date(v).toLocaleString('zh-CN') : '-');
const pct = (v: number) => `${Math.round(v * 100)}%`;
/** 均耗时：>60 秒转「x分y秒」，无样本为 '-' */
const fmtSeconds = (s: number | null) => {
  if (s === null) return '-';
  return s > 60 ? `${Math.floor(s / 60)}分${Math.round(s % 60)}秒` : `${Math.round(s)}秒`;
};
const kindLabel = (k: string) => STAFF_RECORD_KIND_LABEL[k as StaffRecordKind] ?? k;
const kindTag = (k: string) => STAFF_RECORD_KIND_TAG[k as StaffRecordKind] ?? 'info';

// —— 五维雷达（施工量/交付率/低返工/产值/活跃）：原始值 → 组内各维 max 归一（除数下限 1 防零） ——
const radarRaw = (t: TechnicianCard): number[] => {
  const { total, delivered, rework, revenueFen } = t.stats;
  // 无施工（total=0）时比率维记 0：无数据不评分
  return [
    total,
    total > 0 ? delivered / total : 0,
    total > 0 ? 1 - rework / total : 0,
    revenueFen,
    total,
  ];
};
const radarById = computed<Record<string, number[]>>(() => {
  const list = data.value?.technicians ?? [];
  const raws = list.map(radarRaw);
  const maxes = [0, 1, 2, 3, 4].map((i) => Math.max(1, ...raws.map((r) => r[i])));
  const out: Record<string, number[]> = {};
  list.forEach((t, idx) => {
    out[t.id] = raws[idx].map((v, i) => v / maxes[i]);
  });
  return out;
});

// —— 新增技师 / 改名（写端点后端限 boss|store_manager） ——
const addTechnician = async () => {
  const { value } = await ElMessageBox.prompt(
    '技师姓名（建档后可改名/停用，专长可后续维护）',
    '新增技师',
    {
      inputPattern: /\S+/,
      inputErrorMessage: '姓名不能为空',
    },
  );
  await createTechnician({ name: value.trim() });
  ElMessage.success('技师已建档');
  await load();
};

const renameTechnician = async (t: TechnicianCard) => {
  const { value } = await ElMessageBox.prompt(
    '新姓名（改名后忙闲与施工指标按新姓名匹配）',
    `技师改名：${t.name}`,
    { inputValue: t.name, inputPattern: /\S+/, inputErrorMessage: '姓名不能为空' },
  );
  const name = value.trim();
  if (name === t.name) return;
  await updateTechnician(t.id, { name });
  ElMessage.success('已改名');
  await load();
};

// —— 技能编辑（PATCH skills 枚举数组；保存 []=清空） ——
const skillDialogVisible = ref(false);
const skillSaving = ref(false);
const skillForm = ref<{ id: string; name: string; skills: string[] }>({
  id: '',
  name: '',
  skills: [],
});

const openSkillEdit = (t: TechnicianCard) => {
  skillForm.value = { id: t.id, name: t.name, skills: [...t.skills] };
  skillDialogVisible.value = true;
};

const submitSkills = async () => {
  skillSaving.value = true;
  try {
    await updateTechnician(skillForm.value.id, { skills: skillForm.value.skills });
    ElMessage.success('技能已更新');
    skillDialogVisible.value = false;
    await load();
  } finally {
    skillSaving.value = false;
  }
};

// —— 批量改名（逐条 PATCH name，allSettled 汇报成败数；未改动/空名行跳过） ——
const batchRenameVisible = ref(false);
const batchRenameSaving = ref(false);
const batchRenameRows = ref<{ id: string; oldName: string; newName: string }[]>([]);

const openBatchRename = () => {
  batchRenameRows.value = (data.value?.technicians ?? []).map((t) => ({
    id: t.id,
    oldName: t.name,
    newName: t.name,
  }));
  batchRenameVisible.value = true;
};

const submitBatchRename = async () => {
  const changed = batchRenameRows.value
    .map((r) => ({ id: r.id, oldName: r.oldName, name: r.newName.trim() }))
    .filter((r) => r.name && r.name !== r.oldName);
  if (!changed.length) {
    ElMessage.warning('没有需要改名的技师');
    return;
  }
  batchRenameSaving.value = true;
  try {
    const results = await Promise.allSettled(
      changed.map((r) => updateTechnician(r.id, { name: r.name })),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - ok;
    if (failed === 0) ElMessage.success(`批量改名完成：成功 ${ok} 条`);
    else ElMessage.warning(`批量改名：成功 ${ok} 条，失败 ${failed} 条`);
    batchRenameVisible.value = false;
    await load();
  } finally {
    batchRenameSaving.value = false;
  }
};

// —— 录入记录（考勤/奖惩/备注，只增不改） ——
const recordVisible = ref(false);
const submitRecord = async (payload: {
  subjectId: string;
  kind: StaffRecordKind;
  content: string;
  occurredAt: string;
}) => {
  await createRecord(payload);
  ElMessage.success('记录已录入');
  recordVisible.value = false;
  await load();
};

onMounted(load);
</script>

<template>
  <div v-loading="loading" class="team">
    <div class="team__head">
      <h2>人机团队</h2>
      <div>
        <el-button v-if="canManage" type="primary" @click="addTechnician">新增技师</el-button>
        <el-button v-if="canManage" @click="openBatchRename">批量改名</el-button>
        <el-button @click="load">刷新</el-button>
      </div>
    </div>

    <!-- 上区：技师卡网格（名/技能/忙闲/四指标/五维雷达） -->
    <section class="team__section">
      <h3 class="team__section-title">技师（{{ data?.technicians.length ?? 0 }}）</h3>
      <div class="team__grid">
        <TeamTechnicianCard
          v-for="t in data?.technicians ?? []"
          :key="t.id"
          :technician="t"
          :radar="radarById[t.id] ?? []"
          :can-manage="canManage"
          @rename="renameTechnician(t)"
          @edit-skills="openSkillEdit(t)"
        />
      </div>
      <el-empty
        v-if="data && data.technicians.length === 0"
        description="暂无技师，点「新增技师」建档"
        :image-size="60"
      />
    </section>

    <!-- 中区：Agent 花名册（近 30 天） -->
    <section class="team__section">
      <h3 class="team__section-title">AI 数字员工（近 30 天）</h3>
      <el-table :data="data?.agents ?? []" border stripe>
        <el-table-column label="身份" width="80">
          <template #default>
            <span class="team__ai-badge">AI</span>
          </template>
        </el-table-column>
        <el-table-column label="技能" min-width="180">
          <template #default="{ row }">
            <div>{{ (row as AgentRow).skillName }}</div>
            <div class="wg-muted team__task-type">{{ (row as AgentRow).taskType }}</div>
          </template>
        </el-table-column>
        <el-table-column label="近30天任务数" width="110">
          <template #default="{ row }">{{ (row as AgentRow).recent30d.total }}</template>
        </el-table-column>
        <el-table-column label="完成率" width="90">
          <template #default="{ row }">{{ pct((row as AgentRow).recent30d.doneRate) }}</template>
        </el-table-column>
        <el-table-column label="均耗时" width="100">
          <template #default="{ row }">{{
            fmtSeconds((row as AgentRow).recent30d.avgSeconds)
          }}</template>
        </el-table-column>
        <el-table-column label="最近运行" width="170">
          <template #default="{ row }">{{ fmt((row as AgentRow).recent30d.lastRunAt) }}</template>
        </el-table-column>
      </el-table>
    </section>

    <!-- 下区：考勤奖惩记录（近 20 条，只增不改） -->
    <section class="team__section">
      <div class="team__records-head">
        <h3 class="team__section-title">考勤奖惩记录（近 20 条）</h3>
        <el-button v-if="canManage" type="primary" @click="recordVisible = true"
          >录入记录</el-button
        >
      </div>
      <el-table :data="data?.records ?? []" border>
        <el-table-column label="类型" width="80">
          <template #default="{ row }">
            <el-tag :type="kindTag((row as StaffRecordRow).kind)" size="small">
              {{ kindLabel((row as StaffRecordRow).kind) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="对象" width="100">
          <template #default="{ row }">{{ (row as StaffRecordRow).subjectName ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="内容" min-width="240">
          <template #default="{ row }">{{ (row as StaffRecordRow).content }}</template>
        </el-table-column>
        <el-table-column label="发生日期" width="170">
          <template #default="{ row }">{{ fmt((row as StaffRecordRow).occurredAt) }}</template>
        </el-table-column>
      </el-table>
    </section>

    <TeamRecordDialog
      v-model:visible="recordVisible"
      :technicians="data?.technicians ?? []"
      @submit="submitRecord"
    />

    <!-- 技能编辑对话框（多选工种枚举，保存 []=清空） -->
    <el-dialog v-model="skillDialogVisible" :title="`技能编辑：${skillForm.name}`" width="400px">
      <el-select
        v-model="skillForm.skills"
        multiple
        class="team__skill-select"
        placeholder="选择工种（可多选，不选即清空）"
      >
        <el-option
          v-for="s in TECHNICIAN_SKILL_OPTIONS"
          :key="s"
          :value="s"
          :label="TECHNICIAN_SKILL_LABEL[s] ?? s"
        />
      </el-select>
      <template #footer>
        <el-button @click="skillDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="skillSaving" @click="submitSkills">保存</el-button>
      </template>
    </el-dialog>

    <!-- 批量改名对话框：每行 旧名 → 新名输入框，提交逐条 PATCH -->
    <el-dialog v-model="batchRenameVisible" title="批量改名" width="440px">
      <div v-for="row in batchRenameRows" :key="row.id" class="team__rename-row">
        <span class="team__rename-old">{{ row.oldName }}</span>
        <span class="team__rename-arrow">→</span>
        <el-input v-model="row.newName" placeholder="新姓名" />
      </div>
      <el-empty v-if="!batchRenameRows.length" description="暂无技师可改名" :image-size="40" />
      <template #footer>
        <el-button @click="batchRenameVisible = false">取消</el-button>
        <el-button type="primary" :loading="batchRenameSaving" @click="submitBatchRename">
          提交
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.team {
  display: flex;
  flex-direction: column;
  gap: 16px;
  /* V2.6 布局修复：留白统一由 el-main 24px padding 提供 */
  width: 100%;
}
.team__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.team__section-title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--wg-ink);
}
.team__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}
/* AI 徽标：蓝色圆角小标（区别技师行的「人」身份） */
.team__ai-badge {
  display: inline-block;
  padding: 1px 8px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: var(--el-color-primary);
  border-radius: 10px;
}
.team__task-type {
  font-size: 12px;
}
.team__records-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.team__records-head .team__section-title {
  margin: 0;
}
/* 技能编辑：多选下拉撑满对话框宽度 */
.team__skill-select {
  width: 100%;
}
/* 批量改名行：旧名固定宽，箭头居中，新名输入框自适应 */
.team__rename-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.team__rename-old {
  width: 88px;
  overflow: hidden;
  font-weight: 600;
  color: var(--wg-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.team__rename-arrow {
  color: var(--wg-ink-muted);
}
.team__rename-row .el-input {
  flex: 1;
}
</style>
