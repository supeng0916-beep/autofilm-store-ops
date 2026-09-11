<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, ref } from 'vue';

import { knowledgeApi, type KnowledgeItem } from '../api/knowledge';
import EmptyState from '../components/ui/EmptyState.vue';
import FilterBar from '../components/ui/FilterBar.vue';
import WgHintIcon from '../components/ui/WgHintIcon.vue';
import PageHeader from '../components/ui/PageHeader.vue';
import KnowledgeVersionDrawer from './KnowledgeVersionDrawer.vue';
import { usePermission } from '../composables/usePermission';

const { can } = usePermission();
const canEdit = () => can('m06:edit');

// ─── 列表状态 ───
const items = ref<KnowledgeItem[]>([]);
const loading = ref(false);
const kindFilter = ref('');
const statusFilter = ref('');
const keyword = ref('');

const kindOptions = [
  { label: '产品', value: 'product' },
  { label: '价格', value: 'price' },
  { label: '质保', value: 'warranty' },
  { label: '品牌规范', value: 'brand' },
  { label: '案例', value: 'case' },
  { label: '技师专长', value: 'technician' },
  { label: '销售方法', value: 'sales_method' },
  { label: '交付养护', value: 'care' },
];

const statusOptions = [
  { label: '草稿', value: 'draft' },
  { label: '生效', value: 'active' },
  { label: '过期', value: 'expired' },
];

const kindLabel = (k: string) => kindOptions.find((o) => o.value === k)?.label ?? k;
const statusLabel = (s: string) => statusOptions.find((o) => o.value === s)?.label ?? s;
/** 状态 pill 色板（V2.5）：生效绿 / 草稿灰 / 过期红 */
const statusTag = (s: string) => {
  if (s === 'active') return 'success';
  if (s === 'expired') return 'danger';
  return 'info';
};

const load = async () => {
  loading.value = true;
  try {
    items.value = await knowledgeApi.list({
      ...(kindFilter.value ? { kind: kindFilter.value } : {}),
      ...(statusFilter.value ? { status: statusFilter.value } : {}),
      ...(keyword.value ? { keyword: keyword.value } : {}),
    });
  } finally {
    loading.value = false;
  }
};

onMounted(load);

// ─── 品牌筛选（2026-08-21 门店反馈：选类别后可按品牌二次过滤，只看该品牌条目）───
const brandFilter = ref('');

/** 品牌识别：按标题关键词归类（演示品牌乙/演示品牌），未命中归「通用」 */
const BRAND_RULES: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: '演示品牌乙', re: /演示品牌乙/i },
  { label: '演示品牌', re: /演示品牌|DEMO BRAND|DM22/i },
];
const brandOf = (item: KnowledgeItem): string => {
  for (const rule of BRAND_RULES) {
    if (rule.re.test(item.title)) return rule.label;
  }
  return '通用';
};

/** 当前筛选结果中出现的品牌（带条数），驱动 chips；类别/状态/关键词变化随列表自动更新 */
const brandOptions = computed(() => {
  const counts = new Map<string, number>();
  for (const it of items.value) {
    counts.set(brandOf(it), (counts.get(brandOf(it)) ?? 0) + 1);
  }
  const order = [...BRAND_RULES.map((r) => r.label), '通用'];
  return order.filter((b) => counts.has(b)).map((b) => ({ label: b, count: counts.get(b)! }));
});

/** 表格数据：类别/状态/关键词（服务端过滤）+ 品牌（客户端过滤） */
const displayItems = computed(() =>
  brandFilter.value ? items.value.filter((it) => brandOf(it) === brandFilter.value) : items.value,
);

/** 类别切换：品牌筛选复位（不同类别的品牌集合不同） */
const onKindChange = () => {
  brandFilter.value = '';
  void load();
};

// ─── 新建/编辑对话框 ───
const dialogVisible = ref(false);
const dialogTitle = ref('');
const editingId = ref<string | null>(null);
const form = ref({
  kind: 'product',
  key: '',
  title: '',
  content: '',
  source: '',
  licensed: false,
  expiresAt: '',
});

const openCreate = () => {
  editingId.value = null;
  dialogTitle.value = '新建知识条目';
  form.value = {
    kind: 'product',
    key: '',
    title: '',
    content: '',
    source: '',
    licensed: false,
    expiresAt: '',
  };
  dialogVisible.value = true;
};

const openEdit = async (row: unknown) => {
  const item = row as KnowledgeItem;
  editingId.value = item.id;
  dialogTitle.value = '编辑知识条目';
  form.value = {
    kind: item.kind,
    key: item.key,
    title: item.title,
    content: item.content,
    source: item.source ?? '',
    licensed: item.licensed,
    expiresAt: item.expiresAt ?? '',
  };
  dialogVisible.value = true;
};

const submitForm = async () => {
  try {
    const data = {
      kind: form.value.kind,
      key: form.value.key,
      title: form.value.title,
      content: form.value.content,
      source: form.value.source || undefined,
      licensed: form.value.licensed,
      expiresAt: form.value.expiresAt || undefined,
    };
    if (editingId.value) {
      await knowledgeApi.update(editingId.value, data);
      ElMessage.success('知识条目已更新');
    } else {
      await knowledgeApi.create(data);
      ElMessage.success('知识条目已创建');
    }
    dialogVisible.value = false;
    await load();
  } catch {
    // http 拦截器已 toast
  }
};

// ─── 操作 ───
const handleActivate = async (item: unknown) => {
  const ki = item as KnowledgeItem;
  try {
    const result = await knowledgeApi.activate(ki.id);
    if ('approvalId' in result) {
      ElMessage.info('价格类知识条目已提交审批');
    } else {
      ElMessage.success('知识条目已生效');
    }
    await load();
  } catch {
    // http 拦截器已 toast
  }
};

const handleExpire = async (item: unknown) => {
  const ki = item as KnowledgeItem;
  try {
    await ElMessageBox.confirm('确定要过期该知识条目吗？', '确认', { type: 'warning' });
    await knowledgeApi.expire(ki.id);
    ElMessage.success('知识条目已过期');
    await load();
  } catch {
    // 取消或错误
  }
};

// ─── 版本历史 ───
const versionDrawer = ref(false);
const versionItem = ref<KnowledgeItem | null>(null);

const showVersions = (rowArg: unknown) => {
  versionItem.value = rowArg as KnowledgeItem;
  versionDrawer.value = true;
};
</script>

<template>
  <div class="knowledge-manage wg-page">
    <PageHeader
      title="知识库管理"
      sub="产品/价格/质保等对外口径的唯一事实源，生效条目供 AI 检索引用"
    >
      <template #actions>
        <WgHintIcon k="knowledge.lifecycle" />
        <el-button v-if="canEdit()" type="primary" round @click="openCreate">新建条目</el-button>
      </template>
    </PageHeader>

    <!-- 过滤栏 -->
    <FilterBar>
      <el-select
        v-model="kindFilter"
        placeholder="类别"
        clearable
        class="knowledge-manage__filter"
        @change="onKindChange"
      >
        <el-option v-for="o in kindOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-select
        v-model="statusFilter"
        placeholder="状态"
        clearable
        class="knowledge-manage__filter"
        @change="load"
      >
        <el-option v-for="o in statusOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-input
        v-model="keyword"
        placeholder="关键词搜索"
        clearable
        class="knowledge-manage__keyword"
        @change="load"
      />
      <!-- 品牌二次过滤（选中类别后出现）：只看该品牌条目，点「全部品牌」恢复 -->
      <div
        v-if="kindFilter && brandOptions.length > 0"
        class="knowledge-manage__brands"
        data-test="brand-chips"
      >
        <button
          class="knowledge-manage__brand-chip"
          :class="{ 'is-active': brandFilter === '' }"
          data-test="brand-chip-all"
          @click="brandFilter = ''"
        >
          全部品牌
        </button>
        <button
          v-for="b in brandOptions"
          :key="b.label"
          class="knowledge-manage__brand-chip"
          :class="{ 'is-active': brandFilter === b.label }"
          :data-test="`brand-chip-${b.label}`"
          @click="brandFilter = b.label"
        >
          {{ b.label }} {{ b.count }}
        </button>
      </div>
    </FilterBar>

    <!-- 列表 -->
    <el-table v-loading="loading" :data="displayItems" class="wg-table">
      <el-table-column prop="title" label="标题" min-width="150" />
      <el-table-column prop="kind" label="类别" width="100">
        <template #default="{ row }">{{ kindLabel(row.kind) }}</template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="80">
        <template #default="{ row }">
          <el-tag :type="statusTag(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="version" label="版本" width="60" />
      <el-table-column prop="source" label="来源" min-width="120" />
      <el-table-column prop="licensed" label="授权" width="60">
        <template #default="{ row }">{{ row.licensed ? '是' : '否' }}</template>
      </el-table-column>
      <el-table-column prop="updatedAt" label="更新时间" width="160">
        <template #default="{ row }">{{ new Date(row.updatedAt).toLocaleString() }}</template>
      </el-table-column>
      <el-table-column label="操作" width="230" fixed="right">
        <template #default="{ row }">
          <el-button v-if="canEdit()" size="small" round @click="openEdit(row)">编辑</el-button>
          <el-button
            v-if="canEdit() && row.status === 'draft'"
            size="small"
            round
            type="success"
            @click="handleActivate(row)"
            >生效</el-button
          >
          <el-button
            v-if="canEdit() && row.status === 'active'"
            size="small"
            round
            type="warning"
            @click="handleExpire(row)"
            >过期</el-button
          >
          <el-button size="small" round @click="showVersions(row)">版本</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <EmptyState desc="暂无知识条目" />
      </template>
    </el-table>

    <!-- 新建/编辑对话框 -->
    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="600px">
      <el-form :model="form" label-width="80px">
        <el-form-item label="类别">
          <el-select v-model="form.kind" :disabled="!!editingId">
            <el-option v-for="o in kindOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="业务键">
          <el-input v-model="form.key" :disabled="!!editingId" placeholder="如 product-dm04" />
        </el-form-item>
        <el-form-item label="标题">
          <el-input v-model="form.title" />
        </el-form-item>
        <el-form-item label="内容">
          <el-input v-model="form.content" type="textarea" :rows="4" />
        </el-form-item>
        <el-form-item label="来源">
          <el-input v-model="form.source" placeholder="如演示品牌官方手册" />
        </el-form-item>
        <el-form-item label="授权">
          <el-switch v-model="form.licensed" />
        </el-form-item>
        <el-form-item label="失效时间">
          <el-date-picker v-model="form.expiresAt" type="datetime" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button round @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" round @click="submitForm">保存</el-button>
      </template>
    </el-dialog>

    <!-- 版本历史抽屉（子组件：打开即自取版本列表） -->
    <KnowledgeVersionDrawer v-model="versionDrawer" :item="versionItem" />
  </div>
</template>

<style scoped>
.knowledge-manage__filter {
  width: 140px;
}
.knowledge-manage__keyword {
  width: 220px;
}
/* 品牌二次过滤 chips（选中类别后出现） */
.knowledge-manage__brands {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: 8px;
}
.knowledge-manage__brand-chip {
  border: none;
  border-radius: 12px;
  padding: 3px 10px;
  font-size: 12px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
  cursor: pointer;
}
.knowledge-manage__brand-chip:hover {
  background: var(--el-fill-color);
}
.knowledge-manage__brand-chip.is-active {
  background: var(--el-color-primary);
  color: #fff;
}
</style>
