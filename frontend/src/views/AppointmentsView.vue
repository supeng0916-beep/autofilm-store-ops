<script setup lang="ts">
// 预约管理（P5，M07）：发起预约（m07:edit）、档期冲突提示、店长确认状态、技师替换（客户确认后生效）
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import { leadsApi, type Lead } from '../api/leads';
import {
  appointmentApi,
  BUSINESS_TYPE_LABEL,
  BUSINESS_TYPE_OPTIONS,
  BUSINESS_TYPE_REQUIRED_SKILL,
  type Appointment,
  type BusinessType,
  type TechnicianChange,
} from '../api/appointment';
import { overview, type TechnicianCard } from '../api/team';
import EmptyState from '../components/ui/EmptyState.vue';
import WgHint from '../components/ui/WgHint.vue';
import PageHeader from '../components/ui/PageHeader.vue';
import { usePermission } from '../composables/usePermission';

const { can } = usePermission();
const list = ref<Appointment[]>([]);
const loading = ref(false);
const changesOf = ref<Record<string, TechnicianChange[]>>({});
/** 业务类型列标签（空值=历史单未分类） */
const businessTypeLabel = (v: BusinessType | null) => (v ? BUSINESS_TYPE_LABEL[v] : '未分类');

const statusLabel: Record<string, string> = {
  pending: '待店长确认',
  confirmed: '已确认',
  cancelled: '已取消',
};
const statusTag: Record<string, 'primary' | 'success' | 'warning' | 'info' | 'danger'> = {
  pending: 'warning',
  confirmed: 'success',
  cancelled: 'info',
};
const methodLabel: Record<string, string> = { wechat: '微信', phone: '电话', onsite: '到店' };
const fmt = (v: string | null) => (v ? new Date(v).toLocaleString('zh-CN') : '-');

const load = async () => {
  loading.value = true;
  try {
    list.value = (await appointmentApi.list()).sort((a, b) => a.startAt.localeCompare(b.startAt));
  } finally {
    loading.value = false;
  }
};

// —— 新建（销售发起；409 冲突时展示冲突详情） ——
const dialogVisible = ref(false);
// —— 客资远程搜索（2026-08-25 老板反馈「客户 ID 没人知道怎么填」：改为按客资检索，二选一） ——
const leadOptions = ref<Lead[]>([]);
const leadSearching = ref(false);
const searchLeads = async (keyword: string) => {
  if (!keyword.trim()) {
    leadOptions.value = [];
    return;
  }
  leadSearching.value = true;
  try {
    leadOptions.value = await leadsApi.list({ keyword: keyword.trim() });
  } catch {
    leadOptions.value = []; // http 拦截器已 toast
  } finally {
    leadSearching.value = false;
  }
};
const leadOptionLabel = (l: Lead) =>
  `${l.leadNo}${l.customerName ? ` · ${l.customerName}` : ''} · ${l.sourcePlatform}`;
const submitting = ref(false);
const form = ref({
  leadId: '',
  customerId: '',
  businessType: '' as BusinessType | '',
  serviceItem: '',
  workbench: '',
  technicianName: '',
  technicianDesignated: false,
  startAt: '',
  endAt: '',
  promise: '',
});
const openCreate = () => {
  leadOptions.value = [];
  form.value = {
    leadId: '',
    customerId: '',
    businessType: '',
    serviceItem: '',
    workbench: '',
    technicianName: '',
    technicianDesignated: false,
    startAt: '',
    endAt: '',
    promise: '',
  };
  dialogVisible.value = true;
};

// —— 技师池（v1.5 §5.4；2026-08-27 老板反馈「只显示两个师傅」修正展示口径）：
// 技能过滤规则不变（派工硬校验后端仍强制），但下拉展示全部在职技师——无对应技能的
// 置灰并标注原因，让老板看得到整个团队、明白为什么有的选不了（原先直接隐藏，看起来像丢人）。
const teamTechs = ref<TechnicianCard[]>([]);
/** 当前业务类型所需工种（未选业务类型或 home_film 为 null=不过滤） */
const requiredSkill = computed(() =>
  form.value.businessType ? BUSINESS_TYPE_REQUIRED_SKILL[form.value.businessType] : null,
);
const SKILL_LABEL: Record<string, string> = {
  window_film: '窗膜',
  car_cover: '车衣',
  color_change: '改色膜',
};
/** 可选的技师（含置灰项）：在职 + 标记是否具备当前业务类型所需技能 */
const technicianOptions = computed(() =>
  teamTechs.value
    .filter((t) => t.active)
    .map((t) => ({
      name: t.name,
      selectable: requiredSkill.value === null || t.skills.includes(requiredSkill.value),
    })),
);
const selectableCount = computed(() => technicianOptions.value.filter((t) => t.selectable).length);
/** 切换业务类型：已选技师若无对应技能则清空并提示（置灰项本就选不了，这里兜底异步竞态） */
const onBusinessTypeChange = () => {
  const current = form.value.technicianName;
  const hit = technicianOptions.value.find((t) => t.name === current);
  if (current && !hit?.selectable) {
    form.value.technicianName = '';
    if (current) {
      ElMessage.info('已清空技师：切换业务类型后该技师无对应技能');
    }
  }
};
const loadTeamTechs = async () => {
  try {
    teamTechs.value = (await overview()).technicians;
  } catch {
    // 团队接口失败不阻塞预约表单：技师选择降级为空列表，仍可手动不指定技师提交
    teamTechs.value = [];
  }
};

/** 工位字典（2026-08-28 UI 测试 #5）：存量未取消预约用过的工位去重为选项，
 * 鼓励复用同一写法；新工位仍可输入新建（allow-create） */
const workbenchOptions = computed(() =>
  [
    ...new Set(
      list.value
        .filter((a) => a.status !== 'cancelled' && a.workbench)
        .map((a) => a.workbench as string),
    ),
  ].sort(),
);

const submitCreate = async () => {
  // 业务类型后端必填（v1.5 契约）：本地先拦截，避免无效请求
  if (!form.value.businessType) {
    ElMessage.error('请先选择业务类型');
    return;
  }
  if (!form.value.serviceItem.trim()) {
    ElMessage.error('请填写服务项目');
    return;
  }
  if (!form.value.leadId && !form.value.customerId.trim()) {
    ElMessage.error('请搜索并选择关联客资（或手动填客户档案 ID）');
    return;
  }
  if (!form.value.startAt || !form.value.endAt) {
    ElMessage.error('请选择开始和结束时间');
    return;
  }
  const start = new Date(form.value.startAt);
  const end = new Date(form.value.endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    ElMessage.error('开始和结束时间无效');
    return;
  }
  if (end <= start) {
    ElMessage.error('结束时间必须晚于开始时间');
    return;
  }
  // 2026-08-28 UI 测试 #4：过去时间可建预约（前后端此前均无校验）——本地先拦，
  // 后端 DTO 同口径兜底（留 5 分钟钟差容忍）
  if (start.getTime() < Date.now() - 5 * 60 * 1000) {
    ElMessage.error('开始时间不能早于当前时间，请重新选择');
    return;
  }
  const customerId = form.value.customerId.trim();
  submitting.value = true;
  try {
    await appointmentApi.create({
      ...(form.value.leadId ? { leadId: form.value.leadId } : { customerId }),
      businessType: form.value.businessType as BusinessType,
      serviceItem: form.value.serviceItem.trim(),
      workbench: form.value.workbench || undefined,
      technicianName: form.value.technicianName || undefined,
      technicianDesignated: form.value.technicianDesignated,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      promise: form.value.promise || undefined,
    });
    ElMessage.success('已创建，等待店长在审批中心确认排期');
    dialogVisible.value = false;
    await load();
  } catch (err) {
    const detail = (err as { response?: { data?: { message?: string } } }).response?.data;
    ElMessage.error(detail?.message ?? '创建失败');
  } finally {
    submitting.value = false;
  }
};

const cancel = async (rowArg: unknown) => {
  const row = rowArg as Appointment;
  await ElMessageBox.confirm(
    `取消预约（${row.serviceItem ?? ''} ${fmt(row.startAt)}）？`,
    '取消预约',
  );
  await appointmentApi.cancel(row.id);
  ElMessage.success('已取消，档期已释放');
  await load();
};

// —— 技师替换：发起需客户确认后生效（P5-02） ——
// 2026-08-28 UI 测试 #2：无技师预约补「初次指定」入口——原替换流程只覆盖已有技师，
// 无技师预约除建单时现场指定外无处可补（后端已放开初次指定路径，仍走客户确认后生效）。
const requestChange = async (rowArg: unknown, initial = false) => {
  const row = rowArg as Appointment;
  const { value } = await ElMessageBox.prompt(
    initial ? '指定技师姓名（需客户确认后生效）' : '新技师姓名（替换需客户确认后生效）',
    initial ? '初次指定技师' : '替换技师',
    {
      inputPattern: /\S+/,
      inputErrorMessage: '必填',
    },
  );
  const reason = (
    await ElMessageBox.prompt(
      initial ? '指定说明' : '替换原因',
      initial ? '指定说明' : '替换原因',
      {
        inputPattern: /\S+/,
      },
    )
  ).value;
  await appointmentApi.requestTechnicianChange(row.id, { toName: value, reason });
  ElMessage.success(initial ? '已发起指定，待客户确认' : '已发起替换，待客户确认');
  await expandChanges(row);
};
const expandChanges = async (rowArg: unknown) => {
  const row = rowArg as Appointment;
  changesOf.value[row.id] = await appointmentApi.technicianChanges(row.id);
};
const confirmMethod = ref<Record<string, string>>({});
const confirmChange = async (rowArg: unknown, changeArg: unknown) => {
  const row = rowArg as Appointment;
  const change = changeArg as TechnicianChange;
  const method = (confirmMethod.value[change.id] ?? 'wechat') as 'wechat' | 'phone' | 'onsite';
  await appointmentApi.confirmTechnicianChange(row.id, change.id, { confirmMethod: method });
  ElMessage.success('客户已确认，替换生效');
  await expandChanges(row);
  await load();
};

onMounted(() => {
  void load();
  void loadTeamTechs();
});
</script>

<template>
  <div class="appointments wg-page">
    <PageHeader title="预约与排期" sub="发起预约后待店长确认排期；指定技师替换需客户确认后生效">
      <template #actions>
        <WgHint k="appointment.create" placement="bottom">
          <el-button v-if="can('m07:edit')" type="primary" round @click="openCreate"
            >发起预约</el-button
          >
        </WgHint>
        <el-button round @click="load">刷新</el-button>
      </template>
    </PageHeader>
    <el-table v-loading="loading" :data="list" class="wg-table">
      <el-table-column label="开始" width="150">
        <template #default="{ row }">{{ fmt(row.startAt) }}</template>
      </el-table-column>
      <el-table-column label="结束" width="150">
        <template #default="{ row }">{{ fmt(row.endAt) }}</template>
      </el-table-column>
      <el-table-column prop="serviceItem" label="服务项目" min-width="140" />
      <el-table-column label="业务类型" width="110">
        <template #default="{ row }">{{ businessTypeLabel(row.businessType) }}</template>
      </el-table-column>
      <el-table-column prop="workbench" label="工位" width="90" />
      <el-table-column label="技师" width="130">
        <template #default="{ row }">
          {{ row.technicianName ?? '-' }}
          <el-tag v-if="row.technicianDesignated" size="small" type="danger">指定</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="排期状态" width="110">
        <template #default="{ row }">
          <el-tag :type="statusTag[row.status]">{{ statusLabel[row.status] }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="appointments__expand">
            <p>
              店长确认：{{ row.managerConfirmed ? `是（${fmt(row.managerConfirmedAt)}）` : '否' }}
            </p>
            <p>交付承诺：{{ row.promise ?? '-' }}</p>
            <el-button
              v-if="can('m07:edit') && row.status !== 'cancelled' && !row.technicianName"
              size="small"
              round
              type="warning"
              @click="requestChange(row, true)"
            >
              初次指定技师
            </el-button>
            <el-button
              v-if="can('m07:edit') && row.status !== 'cancelled' && row.technicianName"
              size="small"
              round
              @click="requestChange(row)"
            >
              发起技师替换
            </el-button>
            <el-table
              v-if="changesOf[row.id]?.length"
              :data="changesOf[row.id]"
              size="small"
              class="wg-table appointments__changes"
            >
              <el-table-column prop="fromName" label="原技师" width="90" />
              <el-table-column prop="toName" label="新技师" width="90" />
              <el-table-column prop="reason" label="原因" min-width="120" />
              <el-table-column label="状态" width="90">
                <template #default="{ row: c }">
                  {{
                    c.status === 'confirmed'
                      ? `已确认（${methodLabel[c.confirmMethod ?? ''] ?? c.confirmMethod}）`
                      : '待客户确认'
                  }}
                </template>
              </el-table-column>
              <el-table-column v-if="can('m07:edit')" label="操作" width="180">
                <template #default="{ row: c }">
                  <template v-if="c.status === 'pending'">
                    <el-select
                      v-model="confirmMethod[c.id]"
                      placeholder="确认方式"
                      size="small"
                      style="width: 90px"
                    >
                      <el-option label="微信" value="wechat" />
                      <el-option label="电话" value="phone" />
                      <el-option label="到店" value="onsite" />
                    </el-select>
                    <el-button size="small" type="primary" round @click="confirmChange(row, c)"
                      >确认</el-button
                    >
                  </template>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </template>
      </el-table-column>
      <el-table-column v-if="can('m07:edit')" label="操作" width="100">
        <template #default="{ row }">
          <el-button
            v-if="row.status !== 'cancelled' && (row.status !== 'confirmed' || can('m07:approve'))"
            size="small"
            type="danger"
            plain
            round
            @click="cancel(row)"
          >
            取消
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <EmptyState desc="暂无预约" />
      </template>
    </el-table>

    <el-dialog v-model="dialogVisible" title="发起预约（提交后待店长确认）" width="520px">
      <el-form label-width="100px">
        <el-form-item label="关联客资" required>
          <el-select
            v-model="form.leadId"
            filterable
            remote
            clearable
            :remote-method="searchLeads"
            :loading="leadSearching"
            placeholder="输入客资编号 / 客户称呼搜索"
            data-testid="lead-select"
            style="width: 100%"
          >
            <el-option
              v-for="l in leadOptions"
              :key="l.id"
              :label="leadOptionLabel(l)"
              :value="l.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item v-if="!form.leadId" label="客户档案 ID">
          <el-input v-model="form.customerId" placeholder="高级：直接填客户档案 ID" />
        </el-form-item>
        <el-form-item label="业务类型" required>
          <el-select
            v-model="form.businessType"
            placeholder="选择业务类型"
            style="width: 100%"
            @change="onBusinessTypeChange"
          >
            <el-option
              v-for="o in BUSINESS_TYPE_OPTIONS"
              :key="o.value"
              :label="o.label"
              :value="o.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="服务项目" required>
          <el-input v-model="form.serviceItem" placeholder="如：DM10 全车隔热膜" />
        </el-form-item>
        <el-form-item label="工位">
          <!-- 2026-08-28 UI 测试 #5：工位自由文本写法漂移（工位A/A1）曾绕过冲突检测——
               改为可选可建的字典下拉（存量工位为选项、允许新工位），后端提交前同口径归一化 -->
          <el-select
            v-model="form.workbench"
            filterable
            allow-create
            default-first-option
            clearable
            placeholder="选择工位（可选；同工位同时段会冲突拦截）"
            style="width: 100%"
          >
            <el-option v-for="w in workbenchOptions" :key="w" :label="w" :value="w" />
          </el-select>
        </el-form-item>
        <el-form-item label="技师">
          <el-select
            v-model="form.technicianName"
            :placeholder="`选择技师（可留空；${selectableCount} 位具备当前业务技能，置灰为无此技能）`"
            clearable
            style="width: 100%"
          >
            <el-option
              v-for="t in technicianOptions"
              :key="t.name"
              :label="
                t.selectable
                  ? t.name
                  : `${t.name}（无${SKILL_LABEL[requiredSkill ?? ''] ?? '此'}技能）`
              "
              :value="t.name"
              :disabled="!t.selectable"
            />
          </el-select>
          <div v-if="requiredSkill" class="appointments__tech-hint">
            业务类型「{{ businessTypeLabel(form.businessType || null) }}」需要{{
              SKILL_LABEL[requiredSkill] ?? requiredSkill
            }}技能：{{ selectableCount }} 位师傅可选，其余置灰（派工按技能池校验，防止派错人）
          </div>
        </el-form-item>
        <el-form-item label="指定技师">
          <el-switch v-model="form.technicianDesignated" />
        </el-form-item>
        <el-form-item label="开始时间" required>
          <el-date-picker v-model="form.startAt" type="datetime" />
        </el-form-item>
        <el-form-item label="结束时间" required>
          <el-date-picker v-model="form.endAt" type="datetime" />
        </el-form-item>
        <el-form-item label="交付承诺">
          <el-input v-model="form.promise" placeholder="如：当日 18:00 前交车" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button round @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" round :loading="submitting" @click="submitCreate">提交</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 展开行内边距收口（V2.5） */
.appointments__expand {
  padding: 8px 16px;
}
.appointments__changes {
  margin-top: 8px;
}
</style>

<style scoped>
.appointments__tech-hint {
  font-size: 12px;
  color: var(--wg-ink-muted);
  line-height: 1.5;
  margin-top: 4px;
}
</style>
