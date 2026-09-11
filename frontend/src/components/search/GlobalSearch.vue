<script setup lang="ts">
/* global window, setTimeout, clearTimeout, HTMLElement, KeyboardEvent */
// 全局搜索（V2.3a Task 2）：侧栏常驻搜索框，防抖 400ms 调 GET /search；
// el-popover 面板按节分组（客资/知识库/施工单/预约与排期），点击条目
// router.push(link) 并关闭面板清空输入；⌘K/Ctrl+K 全局聚焦。
// q<2 字不发请求（前端规避后端 422）；仅需登录，无额外权限点。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Search as SearchIcon } from '@element-plus/icons-vue';
import { useRouter } from 'vue-router';

import { appointmentApi, type Appointment } from '../../api/appointment';
import { knowledgeApi, type KnowledgeItem } from '../../api/knowledge';
import {
  searchApi,
  type SearchItem,
  type SearchSection,
  type SearchSectionType,
} from '../../api/search';
import { WO_STAGE_LABEL, workOrderApi, type WorkOrder } from '../../api/workOrder';

const DEBOUNCE_MS = 400;

/** 分区类型 → 中文标签（与侧栏菜单命名对齐） */
const SECTION_LABELS: Record<SearchSectionType, string> = {
  leads: '客资',
  knowledge: '知识库',
  workOrders: '施工单',
  appointments: '预约与排期',
  assets: '素材库',
};

/** 知识类别中文标签（KnowledgeManageView 同口径） */
const KNOWLEDGE_KIND_LABEL: Record<string, string> = {
  product: '产品',
  price: '价格',
  warranty: '质保',
  brand: '品牌规范',
  sales_method: '销售方法',
  technician: '技师',
  case: '案例',
  care: '交付养护',
};

/** 预约状态中文标签 */
const APPT_STATUS_LABEL: Record<string, string> = {
  pending: '待确认',
  confirmed: '已确认',
  cancelled: '已取消',
};

/** 知识状态中文标签（sub 副行美化） */
const KNOWLEDGE_STATUS_LABEL: Record<string, string> = {
  active: '生效',
  draft: '草稿',
  expired: '已过期',
};

const router = useRouter();

const keyword = ref('');
const inputRef = ref<{ focus: () => void } | null>(null);
const wrapEl = ref<HTMLElement | null>(null);
const panelWidth = ref(200);
const panelVisible = ref(false);
const loading = ref(false);
const sections = ref<SearchSection[]>([]);

/** 空节不渲染；totalItems 用于「无匹配」判定 */
const visibleSections = computed(() => sections.value.filter((s) => s.items.length > 0));
const totalItems = computed(() => sections.value.reduce((sum, s) => sum + s.items.length, 0));

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let searchSeq = 0; // 递增序号：仅最后一次发起的请求可写回结果（丢弃迟到响应）

async function doSearch(q: string): Promise<void> {
  const seq = ++searchSeq;
  try {
    const res = await searchApi.search(q);
    if (seq !== searchSeq) return;
    sections.value = res.sections;
  } catch {
    if (seq !== searchSeq) return;
    sections.value = []; // 失败按无结果展示（错误提示由 http 拦截器统一弹出）
  } finally {
    if (seq === searchSeq) loading.value = false;
  }
}

/** 关键词高亮切分：按当前关键词（大小写不敏感）把文本切成 命中/未命中 片段 */
function hlParts(text: string): Array<{ text: string; hit: boolean }> {
  const q = keyword.value.trim().toLowerCase();
  if (!q) return [{ text, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx < 0) {
      parts.push({ text: text.slice(i), hit: false });
      break;
    }
    if (idx > i) parts.push({ text: text.slice(i, idx), hit: false });
    parts.push({ text: text.slice(idx, idx + q.length), hit: true });
    i = idx + q.length;
  }
  return parts;
}

/** 知识 sub 副行美化：kind/status 原始值 → 中文标签 */
function fmtKnowledgeSub(sub: string): string {
  const [kind, status] = sub.split(' · ');
  return [
    KNOWLEDGE_KIND_LABEL[kind] ?? kind,
    status ? (KNOWLEDGE_STATUS_LABEL[status] ?? status) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

watch(keyword, (raw) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  const q = raw.trim();
  if (q.length < 2) {
    // 后端 q 2-100 字符校验：<2 字直接不发请求，并收起面板复位状态
    sections.value = [];
    loading.value = false;
    panelVisible.value = false;
    return;
  }
  panelVisible.value = true;
  loading.value = true;
  debounceTimer = setTimeout(() => void doSearch(q), DEBOUNCE_MS);
});

/** 回车立即检索（跳过防抖等待；输入法组合中的回车不触发）——2026-08-21 门店反馈：回车无反馈 */
function onEnter(e: KeyboardEvent): void {
  if (e.isComposing) return;
  const q = keyword.value.trim();
  if (q.length < 2) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  panelVisible.value = true;
  loading.value = true;
  void doSearch(q);
}

/** 点击条目（2026-08-21 反馈改造）：客资/素材跳专属页面（有详情页/浏览页）；
 * 知识/施工单/预约原地弹详情抽屉——跳列表页等于让人再找一遍，直接看内容本身。 */
function onItemTap(item: SearchItem, sectionType: SearchSectionType): void {
  panelVisible.value = false;
  if (sectionType === 'leads' || sectionType === 'assets') {
    keyword.value = '';
    void router.push(item.link);
    return;
  }
  drawerTarget.value = { type: sectionType, id: item.id, title: item.title, link: item.link };
  void loadDrawerDetail();
}

/** 抽屉详情：知识全文 / 施工单施工信息 / 预约排期信息（按需拉取，失败由拦截器提示） */
type DrawerTarget = {
  type: 'knowledge' | 'workOrders' | 'appointments';
  id: string;
  title: string;
  link: string;
};

const drawerTarget = ref<DrawerTarget | null>(null);
const drawerLoading = ref(false);
const knowledgeDetail = ref<KnowledgeItem | null>(null);
const workOrderDetail = ref<WorkOrder | null>(null);
const appointmentDetail = ref<Appointment | null>(null);

async function loadDrawerDetail(): Promise<void> {
  const t = drawerTarget.value;
  if (!t) return;
  drawerLoading.value = true;
  knowledgeDetail.value = workOrderDetail.value = appointmentDetail.value = null;
  try {
    if (t.type === 'knowledge') knowledgeDetail.value = await knowledgeApi.get(t.id);
    else if (t.type === 'workOrders') workOrderDetail.value = await workOrderApi.get(t.id);
    else appointmentDetail.value = await appointmentApi.get(t.id);
  } catch {
    // 错误提示由 http 响应拦截器统一弹出
  } finally {
    drawerLoading.value = false;
  }
}

function closeDrawer(): void {
  drawerTarget.value = null;
}

/** 抽屉内「前往页面」逃生口：跳对应列表页（保持原 link 行为可达） */
function gotoSectionPage(): void {
  const t = drawerTarget.value;
  closeDrawer();
  keyword.value = '';
  if (t) void router.push(t.link);
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

/** ⌘K（macOS）/ Ctrl+K（Windows/Linux）聚焦搜索框 */
function onGlobalKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    inputRef.value?.focus();
  }
}

onMounted(() => {
  // 面板宽度与输入框对齐（侧栏固定 200px，挂载量一次即可；异常环境回退 200）
  const w = wrapEl.value?.offsetWidth ?? 0;
  if (w > 0) panelWidth.value = w;
  window.addEventListener('keydown', onGlobalKeydown);
});

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  window.removeEventListener('keydown', onGlobalKeydown);
});
</script>

<template>
  <div ref="wrapEl" class="global-search">
    <el-popover
      :visible="panelVisible"
      :trigger="[]"
      placement="bottom-start"
      :width="panelWidth"
      :offset="4"
      :show-arrow="false"
    >
      <template #reference>
        <el-input
          ref="inputRef"
          v-model="keyword"
          :prefix-icon="SearchIcon"
          placeholder="全店搜索 ⌘K"
          clearable
          data-test="global-search-input"
          @keyup.enter="onEnter"
        />
      </template>
      <div v-loading="loading" class="global-search__panel" data-test="global-search-panel">
        <div v-if="!loading && totalItems === 0" class="global-search__empty">无匹配</div>
        <template v-else>
          <div v-for="s in visibleSections" :key="s.type" class="global-search__section">
            <div class="global-search__section-title">{{ SECTION_LABELS[s.type] ?? s.type }}</div>
            <div
              v-for="item in s.items"
              :key="item.id"
              class="global-search__item"
              role="button"
              :data-test="`global-search-item-${item.id}`"
              @click="onItemTap(item, s.type)"
            >
              <div class="global-search__item-title">
                <template v-for="(p, pi) in hlParts(item.title)" :key="pi">
                  <mark v-if="p.hit" class="global-search__hl">{{ p.text }}</mark>
                  <template v-else>{{ p.text }}</template>
                </template>
              </div>
              <div v-if="item.snippet" class="global-search__snippet">
                <template v-for="(p, pi) in hlParts(item.snippet)" :key="pi">
                  <mark v-if="p.hit" class="global-search__hl">{{ p.text }}</mark>
                  <template v-else>{{ p.text }}</template>
                </template>
              </div>
              <div class="global-search__item-sub">
                {{ s.type === 'knowledge' ? fmtKnowledgeSub(item.sub) : item.sub }}
              </div>
            </div>
          </div>
        </template>
      </div>
    </el-popover>
    <!-- 详情抽屉：知识=全文；施工单/预约=完整信息（2026-08-21 反馈：结果要直达内容，不跳列表页） -->
    <el-drawer
      :model-value="drawerTarget !== null"
      :title="drawerTarget ? `${SECTION_LABELS[drawerTarget.type]} · ${drawerTarget.title}` : ''"
      size="440px"
      append-to-body
      data-test="global-search-drawer"
      @close="closeDrawer"
    >
      <div v-loading="drawerLoading" class="global-search__drawer-body">
        <template v-if="drawerTarget?.type === 'knowledge' && knowledgeDetail">
          <div class="global-search__meta">
            <span class="wg-tag">{{
              KNOWLEDGE_KIND_LABEL[knowledgeDetail.kind] ?? knowledgeDetail.kind
            }}</span>
            <span class="wg-tag" :class="knowledgeDetail.status === 'active' ? 'success' : ''">
              {{ knowledgeDetail.status === 'active' ? '生效' : knowledgeDetail.status }}
            </span>
            <span v-if="knowledgeDetail.source" class="global-search__src">
              来源：{{ knowledgeDetail.source }}
            </span>
          </div>
          <pre class="global-search__content">{{ knowledgeDetail.content }}</pre>
        </template>
        <template v-else-if="drawerTarget?.type === 'workOrders' && workOrderDetail">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="施工单号">{{
              workOrderDetail.orderNo
            }}</el-descriptions-item>
            <el-descriptions-item label="阶段">
              {{ WO_STAGE_LABEL[workOrderDetail.stage] ?? workOrderDetail.stage }}
            </el-descriptions-item>
            <el-descriptions-item label="服务项目">{{
              workOrderDetail.serviceItem ?? '—'
            }}</el-descriptions-item>
            <el-descriptions-item label="工位">{{
              workOrderDetail.workbench ?? '—'
            }}</el-descriptions-item>
            <el-descriptions-item label="技师">{{
              workOrderDetail.technicianName ?? '—'
            }}</el-descriptions-item>
            <el-descriptions-item label="施工照片"
              >{{ workOrderDetail.photos?.length ?? 0 }} 张</el-descriptions-item
            >
            <el-descriptions-item v-if="workOrderDetail.deliveredAt" label="交付时间">
              {{ fmtTime(workOrderDetail.deliveredAt) }}
            </el-descriptions-item>
            <el-descriptions-item v-if="workOrderDetail.rework" label="返工">
              {{ workOrderDetail.reworkRecords?.length ?? 0 }} 次
            </el-descriptions-item>
          </el-descriptions>
        </template>
        <template v-else-if="drawerTarget?.type === 'appointments' && appointmentDetail">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="服务项目">{{
              appointmentDetail.serviceItem ?? '—'
            }}</el-descriptions-item>
            <el-descriptions-item label="状态">
              {{ APPT_STATUS_LABEL[appointmentDetail.status] ?? appointmentDetail.status }}
            </el-descriptions-item>
            <el-descriptions-item label="开始时间">{{
              fmtTime(appointmentDetail.startAt)
            }}</el-descriptions-item>
            <el-descriptions-item label="结束时间">
              {{ appointmentDetail.endAt ? fmtTime(appointmentDetail.endAt) : '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="工位">{{
              appointmentDetail.workbench ?? '—'
            }}</el-descriptions-item>
            <el-descriptions-item label="技师">{{
              appointmentDetail.technicianName ?? '—'
            }}</el-descriptions-item>
            <el-descriptions-item label="预计工时">
              {{ appointmentDetail.estHours != null ? `${appointmentDetail.estHours} 小时` : '—' }}
            </el-descriptions-item>
            <el-descriptions-item v-if="appointmentDetail.promise" label="给客户的承诺">
              {{ appointmentDetail.promise }}
            </el-descriptions-item>
          </el-descriptions>
        </template>
        <div v-else-if="!drawerLoading" class="global-search__empty">详情加载失败，稍后重试</div>
      </div>
      <template #footer>
        <el-button round @click="closeDrawer">关闭</el-button>
        <el-button type="primary" round data-test="drawer-goto-page" @click="gotoSectionPage">
          前往{{ drawerTarget ? SECTION_LABELS[drawerTarget.type] : '' }}页面
        </el-button>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.global-search__panel {
  min-height: 40px;
  max-height: 60vh;
  overflow-y: auto;
}
.global-search__empty {
  padding: 12px 0;
  text-align: center;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.global-search__section-title {
  padding: 6px 4px 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
/* 命中片段（content 匹配行）：关键词上下文 */
.global-search__snippet {
  font-size: 12px;
  color: var(--el-text-color-regular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 关键词高亮 */
.global-search__hl {
  background: transparent;
  color: var(--el-color-primary);
  font-weight: 600;
  padding: 0;
}
.global-search__item {
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}
/* hover 高亮：整条两行块可点 */
.global-search__item:hover {
  background: var(--el-fill-color-light);
}
.global-search__item-title {
  font-size: 13px;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.global-search__item-sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 详情抽屉 */
.global-search__drawer-body {
  min-height: 120px;
}
.global-search__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.global-search__src {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.global-search__content {
  margin: 0;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--el-text-color-primary);
}
</style>
