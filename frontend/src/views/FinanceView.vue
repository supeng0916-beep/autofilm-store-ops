<script setup lang="ts">
// 财务收支（批次2 T6，M10）：手工流水台账——三张汇总卡（收入/支出/结余）+筛选+表格+新建。
// 红线：流水只增不改（后端无删除/修改端点）；金额以分为单位存储，页面按元显示；
// 口径：成交额见经营复盘，此处为手工登记的实际收付。
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import {
  DIRECTION_LABEL,
  EXPENSE_CATEGORY_LABEL,
  INCOME_CATEGORY_LABEL,
  financeApi,
  type FinanceEntry,
} from '../api/finance';
import { orderApi, type ArrearsRow } from '../api/order';
import PageHeader from '../components/ui/PageHeader.vue';
import { usePermission } from '../composables/usePermission';

const { can } = usePermission();

const loading = ref(false);
const entries = ref<FinanceEntry[]>([]);
const directionFilter = ref<'' | 'income' | 'expense'>('');
const range = ref<[string, string] | null>(null);

// —— 欠款提醒（批次5 Task 5）：尾款未清的已确认订单清单，面向老板/店长催收 ——
const arrearsLoading = ref(false);
const arrears = ref<ArrearsRow[]>([]);

async function loadArrears(): Promise<void> {
  arrearsLoading.value = true;
  try {
    arrears.value = await orderApi.arrears();
  } finally {
    arrearsLoading.value = false;
  }
}

const fenToYuan = (fen: number): string => (fen / 100).toFixed(2);
const categoryLabel = (row: FinanceEntry): string =>
  (row.direction === 'expense' ? EXPENSE_CATEGORY_LABEL : INCOME_CATEGORY_LABEL)[row.category] ??
  row.category;
const fmtDate = (v: string): string => new Date(v).toLocaleDateString('zh-CN');

/** 汇总（当前筛选结果前端 reduce） */
const summary = computed(() => {
  const income = entries.value
    .filter((e) => e.direction === 'income')
    .reduce((s, e) => s + e.amountFen, 0);
  const expense = entries.value
    .filter((e) => e.direction === 'expense')
    .reduce((s, e) => s + e.amountFen, 0);
  return { income, expense, net: income - expense };
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    entries.value = await financeApi.list({
      ...(directionFilter.value ? { direction: directionFilter.value } : {}),
      ...(range.value
        ? {
            from: new Date(range.value[0]).toISOString(),
            to: new Date(range.value[1]).toISOString(),
          }
        : {}),
    });
  } finally {
    loading.value = false;
  }
}

// —— 新建对话框 ——
const dialog = ref(false);
const saving = ref(false);
const form = ref<{
  direction: 'income' | 'expense';
  category: string;
  amountYuan: number | null;
  occurredOn: string;
  remark: string;
  leadId: string;
}>({
  direction: 'expense',
  category: 'material',
  amountYuan: null,
  occurredOn: '',
  remark: '',
  leadId: '',
});

const categoryOptions = computed(() =>
  form.value.direction === 'expense' ? EXPENSE_CATEGORY_LABEL : INCOME_CATEGORY_LABEL,
);

function openCreate(): void {
  form.value = {
    direction: 'expense',
    category: 'material',
    amountYuan: null,
    occurredOn: new Date().toISOString().slice(0, 10),
    remark: '',
    leadId: '',
  };
  dialog.value = true;
}

async function submit(): Promise<void> {
  if (!form.value.amountYuan || form.value.amountYuan <= 0) {
    ElMessage.warning('请填写大于 0 的金额');
    return;
  }
  saving.value = true;
  try {
    await financeApi.create({
      direction: form.value.direction,
      category: form.value.category,
      amountFen: Math.round(form.value.amountYuan * 100),
      occurredOn: new Date(`${form.value.occurredOn}T00:00:00`).toISOString(),
      ...(form.value.remark.trim() ? { remark: form.value.remark.trim() } : {}),
      ...(form.value.leadId.trim() ? { leadId: form.value.leadId.trim() } : {}),
    });
    ElMessage.success('流水已登记（只增不改）');
    dialog.value = false;
    await load();
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void load();
  void loadArrears();
});
</script>

<template>
  <div class="finance">
    <PageHeader
      title="财务收支"
      hint="流水只增不改；金额以分为单位存储，页面按元显示。口径：成交额见经营复盘，此处为手工登记的实际收付。"
    />

    <div class="finance__cards">
      <el-card shadow="never"
        ><p class="finance__card-label">收入</p>
        <p class="finance__card-value">¥{{ fenToYuan(summary.income) }}</p></el-card
      >
      <el-card shadow="never"
        ><p class="finance__card-label">支出</p>
        <p class="finance__card-value finance__card-value--expense">
          ¥{{ fenToYuan(summary.expense) }}
        </p></el-card
      >
      <el-card shadow="never"
        ><p class="finance__card-label">结余</p>
        <p class="finance__card-value" :class="{ 'finance__card-value--expense': summary.net < 0 }">
          ¥{{ fenToYuan(summary.net) }}
        </p></el-card
      >
    </div>

    <!-- 欠款提醒（批次5 Task 5）：confirmed 且尾款>0；订单总额=已收定金+待收尾款 -->
    <div class="wg-card finance__arrears">
      <h3 class="wg-card-title">欠款提醒</h3>
      <el-table v-loading="arrearsLoading" :data="arrears" empty-text="当前无未收尾款">
        <el-table-column prop="customerName" label="客户" width="120" show-overflow-tooltip />
        <el-table-column prop="phone" label="电话" width="140" show-overflow-tooltip />
        <el-table-column label="订单总额" width="120" align="right">
          <template #default="{ row }">
            ¥{{ fenToYuan((row as ArrearsRow).depositFen + (row as ArrearsRow).balanceFen) }}
          </template>
        </el-table-column>
        <el-table-column label="已收定金" width="120" align="right">
          <template #default="{ row }"> ¥{{ fenToYuan((row as ArrearsRow).depositFen) }} </template>
        </el-table-column>
        <el-table-column label="待收尾款" width="120" align="right">
          <template #default="{ row }">
            <span class="finance__amount--expense">
              ¥{{ fenToYuan((row as ArrearsRow).balanceFen) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="确认时间" width="120">
          <template #default="{ row }">
            {{ fmtDate((row as ArrearsRow).customerConfirmedAt) }}
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="wg-card">
      <div class="finance__filters">
        <el-select
          v-model="directionFilter"
          clearable
          placeholder="全部方向"
          style="width: 140px"
          @change="load"
        >
          <el-option value="income" label="收入" />
          <el-option value="expense" label="支出" />
        </el-select>
        <el-date-picker
          v-model="range"
          type="daterange"
          value-format="YYYY-MM-DD"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          @change="load"
        />
        <el-button @click="load">刷新</el-button>
        <span class="finance__spacer" />
        <el-button v-if="can('m10:edit')" type="primary" @click="openCreate">登记流水</el-button>
      </div>

      <el-table v-loading="loading" :data="entries">
        <el-table-column label="日期" width="120">
          <template #default="{ row }">{{ fmtDate((row as FinanceEntry).occurredOn) }}</template>
        </el-table-column>
        <el-table-column label="方向" width="80">
          <template #default="{ row }">{{
            DIRECTION_LABEL[(row as FinanceEntry).direction]
          }}</template>
        </el-table-column>
        <el-table-column label="分类" width="110">
          <template #default="{ row }">{{ categoryLabel(row as FinanceEntry) }}</template>
        </el-table-column>
        <el-table-column label="金额" width="120" align="right">
          <template #default="{ row }">
            <span
              :class="{ 'finance__amount--expense': (row as FinanceEntry).direction === 'expense' }"
            >
              ¥{{ fenToYuan((row as FinanceEntry).amountFen) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
        <el-table-column prop="leadId" label="关联客资" width="140" show-overflow-tooltip />
      </el-table>
    </div>

    <el-dialog v-model="dialog" title="登记流水" width="460px">
      <el-form label-width="80px">
        <el-form-item label="方向">
          <el-radio-group
            v-model="form.direction"
            @change="form.category = form.direction === 'expense' ? 'material' : 'deal_receipt'"
          >
            <el-radio-button value="expense">支出</el-radio-button>
            <el-radio-button value="income">收入</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="form.category">
            <el-option
              v-for="(label, value) in categoryOptions"
              :key="value"
              :value="value"
              :label="label"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="金额（元）">
          <el-input-number v-model="form.amountYuan" :min="0.01" :precision="2" :step="100" />
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker v-model="form.occurredOn" type="date" value-format="YYYY-MM-DD" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" maxlength="500" />
        </el-form-item>
        <el-form-item label="关联客资">
          <el-input v-model="form.leadId" placeholder="客资 ID（选填）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">登记</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.finance__cards {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}
.finance__cards .el-card {
  flex: 1;
}
.finance__card-label {
  margin: 0 0 4px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.finance__card-value {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
}
.finance__card-value--expense {
  color: var(--el-color-danger);
}
.finance__arrears {
  margin-bottom: 12px;
}
.finance__filters {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.finance__spacer {
  flex: 1;
}
.finance__amount--expense {
  color: var(--el-color-danger);
}
</style>
