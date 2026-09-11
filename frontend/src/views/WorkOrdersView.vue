<script setup lang="ts">
/* global document, FormData */
// 施工单（P5，M08）：阶段推进（记录员 m08:edit / 店长 m08:approve）、照片、异常、
// 返工、养护说明（知识库草稿+人工确认）、案例授权回流；质检交付全部真人确认
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import { appointmentApi, BUSINESS_TYPE_REQUIRED_SKILL, type Appointment } from '../api/appointment';
import { overview, type TechnicianCard } from '../api/team';
import { WO_STAGE_LABEL, workOrderApi, type WorkOrder } from '../api/workOrder';
import EmptyState from '../components/ui/EmptyState.vue';
import WgHint from '../components/ui/WgHint.vue';
import PageHeader from '../components/ui/PageHeader.vue';
import { usePermission } from '../composables/usePermission';
import WorkOrderExpand from './WorkOrderExpand.vue';

const { can } = usePermission();
const list = ref<WorkOrder[]>([]);
const loading = ref(false);
const fmt = (v: string | null) => (v ? new Date(v).toLocaleString('zh-CN') : '-');

const load = async () => {
  loading.value = true;
  try {
    list.value = await workOrderApi.list();
  } finally {
    loading.value = false;
  }
};

// —— 从已确认预约建单 ——
// 2026-08-28 bug3（方案A）：预约未指定技师时，建单必须从人机团队名单现场选定——
// 后端同口径硬校验（缺技师 422），前端先拦避免白跑一趟。
const createVisible = ref(false);
const appts = ref<Appointment[]>([]);
const techs = ref<TechnicianCard[]>([]);
const chosenAppt = ref('');
const chosenTech = ref('');
const chosenApptObj = computed(() => appts.value.find((a) => a.id === chosenAppt.value) ?? null);
/** 选中的预约无技师 → 必须现场指定 */
const survey = ref({ glassArea: '', orientation: '', glassMaterial: '', propertyCondition: '' });
const isHomeFilm = computed(() => chosenApptObj.value?.businessType === 'home_film');
const needsTech = computed(() =>
  Boolean(chosenApptObj.value && !chosenApptObj.value.technicianName),
);
/** 选中预约的业务类型所需工种（历史单/home_film 为 null=不过滤，与后端硬校验同口径） */
const requiredSkill = computed(() => {
  const bt = chosenApptObj.value?.businessType ?? null;
  return bt ? BUSINESS_TYPE_REQUIRED_SKILL[bt] : null;
});
const SKILL_LABEL: Record<string, string> = {
  window_film: '窗膜',
  car_cover: '车衣',
  color_change: '改色膜',
};
/** 技师选项（2026-08-28 P1）：全部在职列出，无对应技能置灰并标注——与预约页同口径，
 * 后端建单路径已同步接入技能池硬校验（422），前端先拦避免白跑 */
const technicianOptions = computed(() =>
  techs.value
    .filter((t) => t.active)
    .map((t) => ({
      ...t,
      selectable: requiredSkill.value === null || t.skills.includes(requiredSkill.value),
    })),
);
const technicianLabel = (t: (typeof technicianOptions.value)[number]): string => {
  let label = t.currentWorkOrder
    ? `${t.name}（${WO_STAGE_LABEL[t.currentWorkOrder.stage] ?? '有单'}）`
    : t.name;
  if (!t.selectable) label += `（无${SKILL_LABEL[requiredSkill.value ?? ''] ?? '对应'}技能）`;
  return label;
};
const openCreate = async () => {
  chosenAppt.value = '';
  chosenTech.value = '';
  appts.value = (await appointmentApi.list()).filter(
    (a) =>
      a.managerConfirmed &&
      a.status !== 'cancelled' &&
      // 2026-08-28 bug4：已有施工单的预约不再出现在建单下拉（后端 409 兜底）
      !list.value.some((w) => w.appointmentId === a.id),
  );
  // 技师名单（含忙闲）：拉取失败不阻塞建单弹窗，仅选择器为空（后端校验仍兜底）
  techs.value = await overview()
    .then((o) => o.technicians)
    .catch(() => [] as TechnicianCard[]);
  createVisible.value = true;
};
const submitCreate = async () => {
  if (needsTech.value && !chosenTech.value) {
    ElMessage.warning('该预约未指定技师，请先选择技师再建单');
    return;
  }
  // 技能池兜底拦截（置灰项本就选不了，这里兜异步竞态；后端 422 硬校验同口径）
  const chosen = technicianOptions.value.find((t) => t.name === chosenTech.value);
  if (needsTech.value && chosenTech.value && chosen && !chosen.selectable) {
    ElMessage.warning(`技师 ${chosenTech.value} 无对应技能，请选择具备该工种的技师`);
    return;
  }
  await workOrderApi.create(
    chosenAppt.value,
    needsTech.value ? chosenTech.value : undefined,
    isHomeFilm.value &&
      (survey.value.glassArea ||
        survey.value.orientation ||
        survey.value.glassMaterial ||
        survey.value.propertyCondition)
      ? {
          ...(survey.value.glassArea ? { glassArea: survey.value.glassArea } : {}),
          ...(survey.value.orientation ? { orientation: survey.value.orientation } : {}),
          ...(survey.value.glassMaterial ? { glassMaterial: survey.value.glassMaterial } : {}),
          ...(survey.value.propertyCondition
            ? { propertyCondition: survey.value.propertyCondition }
            : {}),
        }
      : undefined,
  );
  survey.value = { glassArea: '', orientation: '', glassMaterial: '', propertyCondition: '' };
  ElMessage.success('施工单已建立');
  createVisible.value = false;
  await load();
};

// —— 阶段动作（全部走后端权限与状态机校验） ——
const action = async (fn: () => Promise<unknown>, ok: string) => {
  await fn();
  ElMessage.success(ok);
  await load();
};
const doStart = (row: unknown) => {
  const w = row as WorkOrder;
  return action(() => workOrderApi.start(w.id), '已开工');
};
const doSelfCheck = async (row: unknown) => {
  const w = row as WorkOrder;
  const backfill = await ElMessageBox.confirm('是否补录？（按原发生时间记录）', '技师自检', {
    distinguishCancelAndClose: true,
    confirmButtonText: '补录（带原时间）',
    cancelButtonText: '实时记录',
  }).then(
    () => true,
    () => false,
  );
  const note = (await ElMessageBox.prompt('自检备注', '技师自检', { inputValue: '' })).value;
  await action(
    async () =>
      workOrderApi.selfCheck(w.id, {
        note: note || undefined,
        ...(backfill
          ? {
              occurredAt: (await ElMessageBox.prompt('原发生时间（YYYY-MM-DD HH:mm）', '补录时间'))
                .value,
            }
          : {}),
      }),
    '自检已记录',
  );
};
const doRecheck = async (row: unknown) => {
  const w = row as WorkOrder;
  const note = (await ElMessageBox.prompt('复检备注', '店长复检', { inputValue: '' })).value;
  await action(() => workOrderApi.recheck(w.id, { note: note || undefined }), '复检完成');
};
const doRework = async (row: unknown) => {
  const w = row as WorkOrder;
  const reason = (
    await ElMessageBox.prompt('返工原因（必填，独立记录可回溯）', '返工', {
      inputPattern: /\S+/,
    })
  ).value;
  await action(() => workOrderApi.rework(w.id, { reason }), '已退回施工中');
};
const doDeliver = async (row: unknown) => {
  const w = row as WorkOrder;
  const warranty = (await ElMessageBox.prompt('质保引用（可空）', '交付确认', { inputValue: '' }))
    .value;
  await action(() => workOrderApi.deliver(w.id, { warrantyRef: warranty || undefined }), '已交付');
};

// —— 照片 / 异常 ——
const uploadPhoto = (row: unknown) => {
  const w = row as WorkOrder;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    await action(() => workOrderApi.addPhoto(w.id, formData), '照片已上传');
  };
  input.click();
};
const addAbnormal = async (row: unknown) => {
  const w = row as WorkOrder;
  const description = (await ElMessageBox.prompt('异常描述', '异常记录', { inputPattern: /\S+/ }))
    .value;
  await action(() => workOrderApi.addAbnormal(w.id, { description }), '异常已记录');
};

// —— 养护说明 / 案例授权 ——
const draftCare = async (row: unknown) => {
  const w = row as WorkOrder;
  await workOrderApi.draftCareNotes(w.id);
  ElMessage.info('草稿已生成（来源知识库），请查看详情');
  await load();
};
// —— 养护确认（2026-08-28 bug2：旧实现是空白单行输入框，既不展示草稿也不预填，
// 门店体感「草稿改不了」；改为对话框：上半展示 AI 草稿，下半多行编辑框预填草稿，改完确认） ——
const careVisible = ref(false);
const careSaving = ref(false);
const careOrder = ref<WorkOrder | null>(null);
const careText = ref('');
const confirmCare = (row: unknown) => {
  const w = row as WorkOrder;
  careOrder.value = w;
  careText.value = w.careNotes?.draft ?? '';
  careVisible.value = true;
};
const submitCare = async () => {
  const w = careOrder.value;
  if (!w || !careText.value.trim()) return;
  careSaving.value = true;
  try {
    await action(
      () => workOrderApi.confirmCareNotes(w.id, careText.value.trim()),
      '养护说明已确认',
    );
    careVisible.value = false;
  } finally {
    careSaving.value = false;
  }
};
const caseRequest = async (row: unknown) => {
  const w = row as WorkOrder;
  const authorized = await ElMessageBox.confirm(
    '客户是否同意将本次施工作为案例素材（授权后写入知识库案例草稿，仍需知识库生效流程）？',
    '案例授权询问',
    { confirmButtonText: '已同意', cancelButtonText: '未同意' },
  ).then(
    () => true,
    () => false,
  );
  await action(
    () => workOrderApi.caseRequest(w.id, { authorized, method: 'wechat' }),
    authorized ? '案例草稿已写入知识库' : '已记录未授权（不产生任何案例）',
  );
};

onMounted(load);
</script>

<template>
  <div class="work-orders wg-page">
    <PageHeader title="施工单" sub="阶段推进全部真人确认：自检→店长复检→交付，返工独立留痕可回溯">
      <template #actions>
        <WgHint k="workorder.create" placement="bottom">
          <el-button v-if="can('m08:edit')" type="primary" round @click="openCreate"
            >建施工单</el-button
          >
        </WgHint>
        <el-button round @click="load">刷新</el-button>
      </template>
    </PageHeader>
    <el-table v-loading="loading" :data="list" class="wg-table">
      <el-table-column prop="orderNo" label="单号" width="140" />
      <el-table-column prop="serviceItem" label="服务项目" min-width="130" />
      <el-table-column prop="technicianName" label="技师" width="90" />
      <el-table-column label="勘测" width="70">
        <template #default="{ row }">
          <el-tooltip
            v-if="(row as WorkOrder).homeSurvey"
            :content="`${(row as WorkOrder).homeSurvey?.glassArea ?? ''}｜${(row as WorkOrder).homeSurvey?.orientation ?? ''}`"
          >
            <span>已录</span>
          </el-tooltip>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column prop="workbench" label="工位" width="80" />
      <el-table-column label="阶段" width="100">
        <template #default="{ row }">
          <el-tag :type="row.stage === 'delivered' ? 'success' : row.rework ? 'danger' : 'primary'">
            {{ WO_STAGE_LABEL[row.stage as keyof typeof WO_STAGE_LABEL] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="创建" width="150">
        <template #default="{ row }">{{ fmt(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column type="expand">
        <template #default="{ row }">
          <WorkOrderExpand :order="row as WorkOrder" />
        </template>
      </el-table-column>
      <!-- V2.6 布局修复：操作列按钮允许换行（min-width 收窄），窄窗口靠换行而非撑宽表格 -->
      <el-table-column label="操作" min-width="260" class-name="work-orders__ops-cell">
        <template #default="{ row }">
          <template v-if="row.stage === 'pending' && can('m08:edit')">
            <el-button size="small" round type="primary" @click="doStart(row)">开始施工</el-button>
          </template>
          <template v-if="row.stage === 'in_progress' && can('m08:edit')">
            <WgHint k="workorder.selfCheck" placement="top"
              ><el-button size="small" round type="primary" @click="doSelfCheck(row)"
                >自检</el-button
              ></WgHint
            >
          </template>
          <template v-if="row.stage === 'self_check_done' && can('m08:approve')">
            <WgHint k="workorder.recheck" placement="top"
              ><el-button size="small" round type="primary" @click="doRecheck(row)"
                >复检</el-button
              ></WgHint
            >
          </template>
          <template
            v-if="['self_check_done', 'recheck_done'].includes(row.stage) && can('m08:approve')"
          >
            <WgHint k="workorder.rework" placement="top"
              ><el-button size="small" round type="danger" plain @click="doRework(row)"
                >返工</el-button
              ></WgHint
            >
          </template>
          <template v-if="row.stage === 'recheck_done' && can('m08:approve')">
            <WgHint k="workorder.deliver" placement="top"
              ><el-button size="small" round type="success" @click="doDeliver(row)"
                >交付</el-button
              ></WgHint
            >
          </template>
          <el-button
            v-if="can('m08:edit') && row.stage !== 'delivered'"
            size="small"
            round
            @click="uploadPhoto(row)"
          >
            照片
          </el-button>
          <el-button
            v-if="can('m08:edit') && row.stage !== 'delivered'"
            size="small"
            round
            @click="addAbnormal(row)"
          >
            异常
          </el-button>
          <el-button v-if="can('m08:view')" size="small" round @click="draftCare(row)"
            >养护草稿</el-button
          >
          <el-button
            v-if="can('m08:approve') && row.careNotes && !row.careNotes.confirmed"
            size="small"
            round
            @click="confirmCare(row)"
          >
            养护确认
          </el-button>
          <el-button
            v-if="can('m06:edit') && row.stage === 'delivered' && !row.caseRequest"
            size="small"
            round
            type="warning"
            plain
            @click="caseRequest(row)"
          >
            案例授权
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <EmptyState desc="暂无施工单" />
      </template>
    </el-table>

    <el-dialog v-model="createVisible" title="从已确认预约建施工单" width="480px">
      <el-select
        v-model="chosenAppt"
        placeholder="选择店长已确认的预约"
        style="width: 100%"
        @change="chosenTech = ''"
      >
        <el-option
          v-for="a in appts"
          :key="a.id"
          :label="`${fmt(a.startAt)}｜${a.serviceItem ?? ''}｜${a.technicianName ?? '无技师'}｜${a.workbench ?? '无工位'}`"
          :value="a.id"
        />
      </el-select>
      <!-- bug3：预约无技师时现场指定（人机团队名单+忙闲提示），后端缺技师硬拦截；
           P1：无对应技能的技师置灰标注（与预约页同口径），后端 422 兜底 -->
      <div v-if="needsTech" class="work-orders__tech-pick">
        <p class="work-orders__tech-hint">该预约未指定技师，请选择施工技师（必选）：</p>
        <el-select v-model="chosenTech" placeholder="选择技师" style="width: 100%">
          <el-option
            v-for="t in technicianOptions"
            :key="t.id"
            :label="technicianLabel(t)"
            :value="t.name"
            :disabled="!t.selectable"
          />
        </el-select>
        <p v-if="!techs.length" class="work-orders__tech-empty">
          技师名单为空：请先在「人机团队」页建档技师
        </p>
      </div>
      <template v-if="isHomeFilm">
        <el-divider content-position="left">住宅膜勘测（选填）</el-divider>
        <el-form label-width="90px">
          <el-form-item label="玻璃面积"
            ><el-input v-model="survey.glassArea" placeholder="如 约 25 ㎡"
          /></el-form-item>
          <el-form-item label="朝向"
            ><el-input v-model="survey.orientation" placeholder="如 南向+西晒"
          /></el-form-item>
          <el-form-item label="玻璃材质"
            ><el-input v-model="survey.glassMaterial" placeholder="如 中空双层"
          /></el-form-item>
          <el-form-item label="物业条件"
            ><el-input v-model="survey.propertyCondition" placeholder="进场/用电/登记要求"
          /></el-form-item>
        </el-form>
      </template>

      <template #footer>
        <el-button round @click="createVisible = false">取消</el-button>
        <el-button type="primary" round :disabled="!chosenAppt" @click="submitCreate"
          >创建</el-button
        >
      </template>
    </el-dialog>

    <!-- bug2：养护确认可视化——展示草稿来源与全文，预填后可编辑后确认（替代旧空白单行输入） -->
    <el-dialog v-model="careVisible" title="养护说明人工确认" width="640px">
      <template v-if="careOrder">
        <p v-if="careOrder.careNotes" class="work-orders__care-meta">
          草稿来源：{{ careOrder.careNotes.sources.map((s) => s.title).join('、') || '（无）' }}
        </p>
        <el-input
          v-model="careText"
          type="textarea"
          :rows="10"
          placeholder="养护说明内容（已预填草稿，可直接修改）"
        />
        <p class="work-orders__care-tip">确认后将随交付留痕，交付给客户前请务必核对修改。</p>
      </template>
      <template #footer>
        <el-button round @click="careVisible = false">取消</el-button>
        <el-button
          type="primary"
          round
          :loading="careSaving"
          :disabled="!careText.trim()"
          @click="submitCare"
          >确认养护说明</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* V2.6 布局修复：操作列按钮换行容器——用 flex gap 取代 el-button 相邻默认间距，
 * 列宽不足时按钮折行而不是把表格撑出横向滚动。 */
.work-orders :deep(.work-orders__ops-cell .cell) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.work-orders :deep(.work-orders__ops-cell .cell .el-button + .el-button) {
  margin-left: 0;
}
/* 建单选技师（bug3）与养护确认（bug2）辅助文案 */
.work-orders__tech-pick {
  margin-top: 12px;
}
.work-orders__tech-hint {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--wg-danger);
}
.work-orders__tech-empty {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--wg-ink-muted);
}
.work-orders__care-meta {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--wg-ink-muted);
  word-break: break-all;
}
.work-orders__care-tip {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--wg-ink-muted);
}
</style>
