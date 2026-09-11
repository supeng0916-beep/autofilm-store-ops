<script setup lang="ts">
/* global URL, setTimeout */
// 素材库（V2.3b，M06；v1.5 T14 缩略图/标签/AI 建议采纳）：网格检索、批量上传入口。
// m06:view 可检索取用；编辑位（上传/授权/标签）m06:edit ∪ m06:approve 才显示，
// AI 建议标签仅 m06:edit（与后端 RequirePermission 同点位；前端门禁仅为体验）。
// 文件经带令牌请求取 blob URL 展示——/assets/:id/* 在全局 Bearer 守卫之后，
// <img>/window.open 无法携带 Authorization 头（直链会 401），见 api/asset.ts 注释。
// 缩略图用 GET /assets/:id/thumb（无则后端回退原图），按 id 缓存 blob URL。
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import { fetchAiTaskDetail } from '../api/aiTasks';
import { assetApi, type Asset, ASSET_KIND_LABEL } from '../api/asset';
import { usePermission } from '../composables/usePermission';
import AssetCard from '../components/asset/AssetCard.vue';
import AssetsUploadDialog from './AssetsUploadDialog.vue';

const { can } = usePermission();
const canEdit = () => can('m06:edit') || can('m06:approve');
const canSuggest = () => can('m06:edit');

// —— 筛选与列表（kind 下拉 + keyword 输入 + 查询；tag 输入为前端过滤） ——
const list = ref<Asset[]>([]);
const loading = ref(false);
const kindFilter = ref('');
const keyword = ref('');
const tagFilter = ref('');

const kindOptions = Object.entries(ASSET_KIND_LABEL).map(([value, label]) => ({ value, label }));

/** 前端过滤：列表项已含 tags，输入子串（忽略大小写）命中任一 tag 即保留 */
const visibleList = computed(() => {
  const q = tagFilter.value.trim().toLowerCase();
  if (!q) return list.value;
  return list.value.filter((a) => a.tags.some((t) => t.toLowerCase().includes(q)));
});

// —— 按车型分组（2026-08-25 老板反馈：同车型照片应聚在一处，平铺 1000 张看不过来）——
// 仅照片类（完工案例/施工过程/全部）分组折叠；报价图/产品资料是文档类，平铺直列
// （老板 2026-08-25 口径：分类点报价图不应再出现车型细分）。
const useGroups = computed(
  () => !kindFilter.value || kindFilter.value === 'finished' || kindFilter.value === 'process',
);

interface AssetGroup {
  key: string;
  items: Asset[];
}

/** 车型取 carModel（无则归入「未分类车型」，排在最后）；组内保持列表原序（新在前） */
const groups = computed<AssetGroup[]>(() => {
  const map = new Map<string, Asset[]>();
  for (const a of visibleList.value) {
    const key = a.carModel?.trim() || '未分类车型';
    map.set(key, [...(map.get(key) ?? []), a]);
  }
  return [...map.entries()]
    .map(([key, items]) => ({ key, items }))
    .sort((x, y) => {
      if (x.key === '未分类车型') return 1;
      if (y.key === '未分类车型') return -1;
      return x.key.localeCompare(y.key, 'zh');
    });
});

const activeGroups = ref<string[]>([]);

watch(
  activeGroups,
  (keys) => {
    // 缩略图按展开组懒加载：收起组不渲染 DOM 也不预取（768 张全预取会拖垮页面）
    for (const g of groups.value) {
      if (keys.includes(g.key)) void ensureGroupPreviews(g.items);
    }
  },
  { immediate: true },
);

// 平铺模式（报价图/产品资料）无分组概念：模式切换或列表更新后取当前列表缩略
watch(
  [useGroups, visibleList],
  ([grouped, items]) => {
    if (!grouped) void ensureGroupPreviews(items);
  },
  { immediate: true },
);

watch(
  groups,
  (gs) => {
    // 小结果集（≤8 组或 ≤30 张）或正在按标签过滤：自动展开；
    // 大列表默认收起当车型索引页，点开再看（老板反馈的观感/性能两头痛点）
    const total = gs.reduce((s, g) => s + g.items.length, 0);
    const expandAll = tagFilter.value.trim() !== '' || gs.length <= 8 || total <= 30;
    activeGroups.value = expandAll ? gs.map((g) => g.key) : [];
  },
  { immediate: true },
);

const load = async () => {
  loading.value = true;
  try {
    list.value = await assetApi.list({
      ...(kindFilter.value ? { kind: kindFilter.value } : {}),
      ...(keyword.value.trim() ? { keyword: keyword.value.trim() } : {}),
    });
  } finally {
    loading.value = false;
  }
};
onMounted(load);

// —— 缩略与预览（image 经 thumb 端点取 blob URL 按 id 缓存；PDF 点击时再取） ——
const srcMap = ref<Record<string, string>>({});

/** 组展开时按需取缩略图（只补缺失的，重复展开不重取） */
async function ensureGroupPreviews(items: Asset[]): Promise<void> {
  await Promise.all(
    items
      .filter((a) => a.mediaType === 'image' && !srcMap.value[a.id])
      .map(async (a) => {
        try {
          srcMap.value[a.id] = URL.createObjectURL(await assetApi.fetchThumb(a.id));
        } catch {
          // 单个缩略失败不阻断整页（http 拦截器已 toast）
        }
      }),
  );
}

onUnmounted(() => {
  Object.values(srcMap.value).forEach((u) => URL.revokeObjectURL(u));
});

// —— 上传（子组件 AssetsUploadDialog，成功后回调刷新） ——
const uploadVisible = ref(false);

// —— 标签编辑（对话框：el-tag closable 删除 + 输入添加；规则对齐后端 suggest 输出口径） ——
const TAG_MAX_COUNT = 8;
const TAG_MAX_LEN = 30;

/** 去重 + 单项 ≤30 字 + 总数 ≤8（与 asset.suggest_tags 输出 schema 同口径） */
function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const v = raw.trim();
    if (!v || v.length > TAG_MAX_LEN || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= TAG_MAX_COUNT) break;
  }
  return out;
}

const editTarget = ref<Asset | null>(null);
const editTags = ref<string[]>([]);
const editInput = ref('');
const editSaving = ref(false);
const licensedPending = new Set<string>();
const removingPending = new Set<string>();
const adopting = ref(false);
const editVisible = computed(() => editTarget.value !== null);

function openTagEdit(a: Asset): void {
  editTarget.value = a;
  editTags.value = [...a.tags];
  editInput.value = '';
}

function closeTagEdit(visible: boolean): void {
  if (!visible) editTarget.value = null;
}

function addEditTag(): void {
  const v = editInput.value.trim();
  if (!v) return;
  if (v.length > TAG_MAX_LEN) {
    ElMessage.warning(`标签不超过 ${TAG_MAX_LEN} 字`);
    return;
  }
  if (editTags.value.includes(v)) {
    ElMessage.warning('标签已存在');
    return;
  }
  if (editTags.value.length >= TAG_MAX_COUNT) {
    ElMessage.warning(`标签最多 ${TAG_MAX_COUNT} 个`);
    return;
  }
  editTags.value.push(v);
  editInput.value = '';
}

function removeEditTag(tag: string): void {
  editTags.value = editTags.value.filter((t) => t !== tag);
}

/** 将 PATCH 返回的最新素材覆盖回列表（本地即时一致，免整页重拉） */
function applyUpdated(updated: Asset): void {
  const i = list.value.findIndex((x) => x.id === updated.id);
  if (i >= 0) list.value[i] = updated;
  if (editTarget.value?.id === updated.id) editTarget.value = updated;
  if (suggestTarget.value?.id === updated.id) suggestTarget.value = updated;
}

async function saveEditTags(): Promise<void> {
  if (!editTarget.value) return;
  editSaving.value = true;
  try {
    applyUpdated(await assetApi.update(editTarget.value.id, { tags: editTags.value }));
    editTarget.value = null;
    ElMessage.success('标签已保存');
  } catch {
    // http 拦截器已 toast；保留对话框供重试
  } finally {
    editSaving.value = false;
  }
}

// —— 授权开关（PATCH licensed；失败回滚本地态） ——
async function toggleLicensed(a: Asset, value: boolean): Promise<void> {
  if (licensedPending.has(a.id)) return;
  licensedPending.add(a.id);
  try {
    applyUpdated(await assetApi.update(a.id, { licensed: value }));
  } catch {
    a.licensed = !value; // http 拦截器已 toast，开关回滚
  } finally {
    licensedPending.delete(a.id);
  }
}

// —— 多选与批量授权（2026-08-25 老板反馈：逐个点授权太麻烦，要一键） ——
const selectedIds = ref<string[]>([]);
const batchBusy = ref(false);

function toggleSelect(id: string, checked: boolean): void {
  selectedIds.value = checked
    ? [...new Set([...selectedIds.value, id])]
    : selectedIds.value.filter((x) => x !== id);
}

const groupIds = (g: AssetGroup): string[] => g.items.map((a) => a.id);

function toggleGroupSelect(g: AssetGroup, checked: boolean): void {
  const ids = groupIds(g);
  selectedIds.value = checked
    ? [...new Set([...selectedIds.value, ...ids])]
    : selectedIds.value.filter((id) => !ids.includes(id));
}

/** 批量授权/转内部：成功后本地同步 licensed 并清空选择（列表整体刷新可省） */
async function applyBatchLicensed(ids: string[], licensed: boolean): Promise<void> {
  if (ids.length === 0) {
    ElMessage.warning('请先选择素材');
    return;
  }
  batchBusy.value = true;
  try {
    const { updated } = await assetApi.batchLicensed(ids, licensed);
    const set = new Set(ids);
    for (const a of list.value) if (set.has(a.id)) a.licensed = licensed;
    ElMessage.success(`${licensed ? '已授权' : '已转内部'} ${updated} 项`);
    selectedIds.value = [];
  } catch {
    // http 拦截器已 toast
  } finally {
    batchBusy.value = false;
  }
}

/** 删除素材（2026-08-25 老板需求）：二次确认后调 DELETE；
 * 本地同步移除卡片/选择态/blob 缓存，文件由后端挪回收目录（误删可找回） */
async function removeAsset(a: Asset): Promise<void> {
  if (removingPending.has(a.id)) return;
  try {
    await ElMessageBox.confirm(`确定删除「${a.title}」吗？`, '删除素材', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return; // 用户取消
  }
  if (removingPending.has(a.id)) return;
  removingPending.add(a.id);
  try {
    await assetApi.remove(a.id);
    list.value = list.value.filter((x) => x.id !== a.id);
    selectedIds.value = selectedIds.value.filter((x) => x !== a.id);
    if (srcMap.value[a.id]) {
      URL.revokeObjectURL(srcMap.value[a.id]);
      delete srcMap.value[a.id];
    }
    ElMessage.success('已删除');
  } catch {
    // http 拦截器已 toast
  } finally {
    removingPending.delete(a.id);
  }
}

// —— AI 标签建议（suggest-tags → 轮询 ai_task → 建议 chips 采纳/忽略） ——
const SUGGEST_POLL_INTERVAL_MS = 3_000;
const SUGGEST_POLL_MAX = 20;
const TERMINAL_FAIL_STATUSES = new Set(['failed', 'timeout', 'degraded', 'cancelled']);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const suggestTarget = ref<Asset | null>(null);
const suggestVisible = ref(false);
const suggesting = ref(false);
const suggestedTags = ref<string[]>([]);
/** 取消标志：页面卸载或用户点「忽略」后置位，轮询检查后静默退出（不在卸载后发请求/弹错） */
const suggestCancelled = ref(false);
onUnmounted(() => {
  suggestCancelled.value = true;
});

/** ai_task.output.tags 防御性提取（形态由后端 schema 校验，前端再做类型收窄） */
function extractSuggestedTags(output: unknown): string[] {
  const tags = (output as { tags?: unknown } | null)?.tags;
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
}

async function runSuggest(a: Asset): Promise<void> {
  suggestCancelled.value = false; // 新一轮建议开始：重置取消标志
  suggestTarget.value = a;
  suggestedTags.value = [];
  suggesting.value = true;
  suggestVisible.value = true;
  try {
    // 提交即可能同步返回终态任务（ai-dispatch 同步闭环先例），先判终态再决定是否轮询
    let task = await assetApi.suggestTags(a.id);
    let polls = 0;
    while (task.status !== 'done' && !TERMINAL_FAIL_STATUSES.has(task.status)) {
      // 卸载/忽略即止：每次 sleep 前后都检查，置位则静默退出（不发请求、不弹错）
      if (suggestCancelled.value) return;
      if (polls >= SUGGEST_POLL_MAX) {
        throw new Error('suggest polling timeout');
      }
      await sleep(SUGGEST_POLL_INTERVAL_MS);
      polls += 1;
      if (suggestCancelled.value) return;
      task = (await fetchAiTaskDetail(task.id)).task;
    }
    if (suggestCancelled.value) return;
    if (task.status !== 'done') {
      throw new Error(task.errorMessage ?? 'suggest task failed');
    }
    suggestedTags.value = extractSuggestedTags(task.output);
    if (suggestedTags.value.length === 0) ElMessage.info('AI 未给出标签建议');
  } catch {
    if (suggestCancelled.value) return; // 已取消（卸载/忽略）：静默退出，不弹错
    ElMessage.error('AI 标签建议失败，请稍后重试');
    suggestVisible.value = false;
  } finally {
    suggesting.value = false;
  }
}

/** 忽略：关闭建议对话框并取消在途轮询（防止对话框关闭后继续空转/卸载后弹错） */
function cancelSuggest(): void {
  suggestCancelled.value = true;
  suggestVisible.value = false;
}

/** 采纳：建议标签合入既有 tags（去重、≤8），PATCH 写入后关闭建议对话框 */
async function adoptSuggested(): Promise<void> {
  if (adopting.value || !suggestTarget.value || suggestedTags.value.length === 0) return;
  const merged = normalizeTags([...suggestTarget.value.tags, ...suggestedTags.value]);
  adopting.value = true;
  try {
    applyUpdated(await assetApi.update(suggestTarget.value.id, { tags: merged }));
    suggestVisible.value = false;
    ElMessage.success('已采纳建议标签');
  } catch {
    // http 拦截器已 toast；保留对话框供重试
  } finally {
    adopting.value = false;
  }
}
</script>

<template>
  <div class="assets">
    <h2>素材库<WgHintIcon k="assets.aiUsage" /></h2>
    <el-alert class="assets__watch-tip" type="info" :closable="true" show-icon>
      批量导入：也可直接把文件放入门店机素材待入库文件夹（uploads/inbox），系统每 5 分钟自动入库
    </el-alert>
    <div class="assets__filters">
      <el-select v-model="kindFilter" clearable placeholder="全部类型" @change="load">
        <el-option v-for="o in kindOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-input
        v-model="keyword"
        clearable
        placeholder="关键词（标题/车型）"
        class="assets__keyword"
        @change="load"
      />
      <el-input
        v-model="tagFilter"
        clearable
        placeholder="按标签过滤"
        class="assets__tag-filter"
        data-testid="tag-filter"
      />
      <el-button type="primary" plain @click="load">查询</el-button>
      <el-button v-if="canEdit()" type="primary" @click="uploadVisible = true">上传素材</el-button>
    </div>

    <!-- 多选批量操作条：选中任一卡片后出现（一键授权=老板反馈 2026-08-25） -->
    <div
      v-if="canEdit() && selectedIds.length > 0"
      class="assets__batchbar"
      data-testid="batch-bar"
    >
      <span class="assets__batchbar-count">已选 {{ selectedIds.length }} 项</span>
      <el-button
        size="small"
        type="primary"
        :loading="batchBusy"
        @click="applyBatchLicensed(selectedIds, true)"
        >授权所选</el-button
      >
      <el-button size="small" :loading="batchBusy" @click="applyBatchLicensed(selectedIds, false)"
        >转内部所选</el-button
      >
      <el-button size="small" text @click="selectedIds = []">取消选择</el-button>
    </div>

    <!-- 按车型分组（折叠面板）：大列表默认收起当索引页；组内容懒渲染 + 缩略懒加载 -->
    <div v-loading="loading" class="assets__groups">
      <!-- 三分支都带 !loading：查询加载期间不渲染旧分类内容（老板 2026-08-25 反馈的切换闪现），
           只留 v-loading 动画，避免「完工案例内容在报价图布局里一闪而过」 -->
      <el-empty v-if="!loading && visibleList.length === 0" description="暂无素材" />
      <el-collapse v-else-if="!loading && useGroups" v-model="activeGroups">
        <el-collapse-item v-for="g in groups" :key="g.key" :name="g.key">
          <template #title>
            <span class="assets__group-title" :data-testid="'group-title-' + g.key">{{
              g.key
            }}</span>
            <span class="assets__group-count">{{ g.items.length }} 张</span>
          </template>
          <template v-if="activeGroups.includes(g.key)">
            <div v-if="canEdit()" class="assets__group-tools">
              <el-checkbox
                :model-value="g.items.every((a) => selectedIds.includes(a.id))"
                data-testid="group-select-all"
                @change="(v: string | number | boolean) => toggleGroupSelect(g, v === true)"
                >全选本组</el-checkbox
              >
              <el-button
                size="small"
                type="primary"
                plain
                :loading="batchBusy"
                @click="applyBatchLicensed(groupIds(g), true)"
                >授权整组</el-button
              >
              <el-button
                size="small"
                plain
                :loading="batchBusy"
                @click="applyBatchLicensed(groupIds(g), false)"
                >整组转内部</el-button
              >
            </div>
            <div class="assets__grid">
              <AssetCard
                v-for="a in g.items"
                :key="a.id"
                :asset="a"
                :src="srcMap[a.id]"
                :selected="selectedIds.includes(a.id)"
                :can-edit="canEdit()"
                :can-suggest="canSuggest()"
                :suggesting="suggesting && suggestTarget?.id === a.id"
                @toggle-select="(v) => toggleSelect(a.id, v)"
                @toggle-licensed="(v) => toggleLicensed(a, v)"
                @edit-tags="openTagEdit(a)"
                @suggest="runSuggest(a)"
                @remove="removeAsset(a)"
              />
            </div>
          </template>
        </el-collapse-item>
      </el-collapse>
      <!-- 非照片类（报价图/产品资料）：文档类平铺直列，无分组折叠与组工具（老板 2026-08-25 口径） -->
      <div v-else-if="!loading" class="assets__grid">
        <AssetCard
          v-for="a in visibleList"
          :key="a.id"
          :asset="a"
          :src="srcMap[a.id]"
          :selected="selectedIds.includes(a.id)"
          :can-edit="canEdit()"
          :can-suggest="canSuggest()"
          :suggesting="suggesting && suggestTarget?.id === a.id"
          @toggle-select="(v) => toggleSelect(a.id, v)"
          @toggle-licensed="(v) => toggleLicensed(a, v)"
          @edit-tags="openTagEdit(a)"
          @suggest="runSuggest(a)"
          @remove="removeAsset(a)"
        />
      </div>
    </div>

    <AssetsUploadDialog v-model="uploadVisible" @uploaded="load" />

    <!-- 标签编辑对话框：closable chip 删除 + 输入添加（去重、≤30 字、≤8 个） -->
    <el-dialog
      :model-value="editVisible"
      title="编辑标签"
      width="480px"
      @update:model-value="closeTagEdit"
    >
      <div class="tag-edit">
        <div class="tag-edit__chips">
          <el-tag
            v-for="t in editTags"
            :key="t"
            closable
            class="tag-edit__chip"
            @close="removeEditTag(t)"
            >{{ t }}</el-tag
          >
          <span v-if="editTags.length === 0" class="tag-edit__empty">暂无标签</span>
        </div>
        <div class="tag-edit__input">
          <el-input
            v-model="editInput"
            :maxlength="TAG_MAX_LEN"
            placeholder="输入标签后添加"
            data-testid="tag-input"
            @keyup.enter="addEditTag"
          />
          <el-button type="primary" plain @click="addEditTag">添加</el-button>
        </div>
        <div class="tag-edit__hint">去重；单个 ≤30 字；最多 {{ TAG_MAX_COUNT }} 个</div>
      </div>
      <template #footer>
        <el-button @click="editTarget = null">取消</el-button>
        <el-button type="primary" :loading="editSaving" @click="saveEditTags">保存</el-button>
      </template>
    </el-dialog>

    <!-- AI 建议标签对话框：loading → 建议 chips（采纳合入 tags / 忽略关闭） -->
    <el-dialog :model-value="suggestVisible" title="AI 建议标签" width="480px">
      <div v-loading="suggesting" class="suggest">
        <template v-if="!suggesting">
          <div v-if="suggestedTags.length" class="suggest__chips">
            <el-tag v-for="t in suggestedTags" :key="t" type="warning" class="suggest__chip">{{
              t
            }}</el-tag>
          </div>
          <div v-else class="suggest__empty">暂无建议标签</div>
        </template>
      </div>
      <template #footer>
        <el-button @click="cancelSuggest">忽略</el-button>
        <el-button
          type="primary"
          :disabled="suggesting || adopting || suggestedTags.length === 0"
          :loading="adopting"
          @click="adoptSuggested"
          >采纳</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.assets {
  /* V2.6 布局修复：留白统一由 el-main 24px padding 提供 */
  width: 100%;
}
.assets__watch-tip {
  margin-bottom: 12px;
}
.assets__filters {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}
.assets__filters :deep(.el-select) {
  width: 160px;
}
.assets__keyword {
  width: 220px;
}
.assets__tag-filter {
  width: 180px;
}
.assets__batchbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 8px 12px;
  background: var(--el-color-primary-light-9);
  border: 1px solid var(--el-color-primary-light-7);
  border-radius: 8px;
}
.assets__batchbar-count {
  font-size: 13px;
  color: var(--el-text-color-primary);
}
.assets__groups {
  min-height: 120px;
}
.assets__groups :deep(.el-collapse-item__header) {
  font-size: 15px;
}
.assets__group-title {
  font-weight: 600;
}
.assets__group-count {
  margin-left: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.assets__group-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 4px 0 12px;
}
.assets__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
  margin-bottom: 12px;
}
.tag-edit__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.tag-edit__empty,
.suggest__empty {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.tag-edit__input {
  display: flex;
  gap: 8px;
}
.tag-edit__hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.suggest {
  min-height: 48px;
}
.suggest__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
