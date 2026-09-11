<script setup lang="ts">
/* global navigator */
// 经营任务中心（V2.1 首批）：短视频文案草稿 + 同行信息整理。
// 人机边界：AI 输出一律草稿态——文案由人采用后自行拍摄发布（已复制≠已发送）；
// 同行整理结果只进知识库草稿，人工审核生效。口径 A：人工浏览公开内容+AI 提炼。
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';

import {
  competitorPostApi,
  type CompetitorPost,
  contentRecordApi,
  type ContentRecord,
  inspirationApi,
  type InspirationScanItem,
  type VideoInspiration,
  marketingApi,
  type CompetitorNotesResult,
  type VideoCopyDraft,
  type VideoTopic,
} from '../api/marketing';
import WgHintIcon from '../components/ui/WgHintIcon.vue';
import PageHeader from '../components/ui/PageHeader.vue';
import { usePermission } from '../composables/usePermission';

const route = useRoute();
const { can } = usePermission();
const tab = ref<string>(
  ['video', 'inspiration', 'competitor', 'content', 'board'].includes(String(route.query.tab))
    ? String(route.query.tab)
    : 'video',
);
// —— 内容台账（批次2 T7）：登记已发布内容，编号与客资导入的 contentId 对上即归因 ——
const records = ref<ContentRecord[]>([]);
const contentLoading = ref(false);
const contentDialog = ref(false);
const contentSaving = ref(false);
const contentForm = ref<{
  contentKey: string;
  title: string;
  platform: string;
  publishedAt: string;
  costYuan: number | null;
  note: string;
}>({
  contentKey: '',
  title: '',
  platform: '',
  publishedAt: '',
  costYuan: null,
  note: '',
});
const updateDialog = ref(false);
const updateSaving = ref(false);
const updateForm = ref<{
  id: string;
  title: string;
  viewsCount: number | null;
  likesCount: number | null;
  commentsCount: number | null;
  costYuan: number | null;
  note: string;
}>({
  id: '',
  title: '',
  viewsCount: null,
  likesCount: null,
  commentsCount: null,
  costYuan: null,
  note: '',
});
const fenToYuan = (fen: number): string => (fen / 100).toFixed(2);

async function loadRecords(): Promise<void> {
  contentLoading.value = true;
  try {
    records.value = await contentRecordApi.list();
  } finally {
    contentLoading.value = false;
  }
}

function openContentDialog(): void {
  contentForm.value = {
    contentKey: '',
    title: '',
    platform: '',
    publishedAt: '',
    costYuan: null,
    note: '',
  };
  contentDialog.value = true;
}

async function submitContent(): Promise<void> {
  if (!contentForm.value.contentKey.trim() || !contentForm.value.title.trim()) {
    ElMessage.warning('内容编号与标题必填');
    return;
  }
  contentSaving.value = true;
  try {
    await contentRecordApi.create({
      contentKey: contentForm.value.contentKey.trim(),
      title: contentForm.value.title.trim(),
      ...(contentForm.value.platform.trim() ? { platform: contentForm.value.platform.trim() } : {}),
      ...(contentForm.value.publishedAt
        ? { publishedAt: new Date(`${contentForm.value.publishedAt}T00:00:00`).toISOString() }
        : {}),
      ...(contentForm.value.costYuan
        ? { costFen: Math.round(contentForm.value.costYuan * 100) }
        : {}),
      ...(contentForm.value.note.trim() ? { note: contentForm.value.note.trim() } : {}),
    });
    ElMessage.success('内容已登记');
    contentDialog.value = false;
    await loadRecords();
  } finally {
    contentSaving.value = false;
  }
}

function openUpdateDialog(row: ContentRecord): void {
  updateForm.value = {
    id: row.id,
    title: row.title,
    viewsCount: row.viewsCount,
    likesCount: row.likesCount,
    commentsCount: row.commentsCount,
    costYuan: row.costFen ? row.costFen / 100 : null,
    note: row.note ?? '',
  };
  updateDialog.value = true;
}

async function submitUpdate(): Promise<void> {
  updateSaving.value = true;
  try {
    await contentRecordApi.update(updateForm.value.id, {
      ...(updateForm.value.viewsCount !== null ? { viewsCount: updateForm.value.viewsCount } : {}),
      ...(updateForm.value.likesCount !== null ? { likesCount: updateForm.value.likesCount } : {}),
      ...(updateForm.value.commentsCount !== null
        ? { commentsCount: updateForm.value.commentsCount }
        : {}),
      ...(updateForm.value.costYuan !== null
        ? { costFen: Math.round(updateForm.value.costYuan * 100) }
        : {}),
      ...(updateForm.value.note.trim() ? { note: updateForm.value.note.trim() } : {}),
    });
    ElMessage.success('数据已更新');
    updateDialog.value = false;
    await loadRecords();
  } finally {
    updateSaving.value = false;
  }
}

// —— 同行效果对比（批次4）：人工录入/爬虫填充共用数据，看板对比我们 vs 同行 ——
const cpPosts = ref<CompetitorPost[]>([]);
const cpBoard = ref<{
  competitors: Array<{ account: string; posts: number; totalLikes: number; topLikes: number }>;
  ours: { posts: number; totalLikes: number; topLikes: number };
} | null>(null);
const cpLoading = ref(false);
const cpDialog = ref(false);
const cpSaving = ref(false);
const cpForm = ref({
  account: '',
  title: '',
  likesCount: null as number | null,
  commentsCount: null as number | null,
  activityType: '',
});

async function loadCompetitor(): Promise<void> {
  cpLoading.value = true;
  try {
    const [posts, board] = await Promise.all([competitorPostApi.list(), competitorPostApi.board()]);
    cpPosts.value = posts;
    cpBoard.value = board;
  } finally {
    cpLoading.value = false;
  }
}

async function submitCp(): Promise<void> {
  if (!cpForm.value.account.trim() || !cpForm.value.title.trim()) {
    ElMessage.warning('同行账号与标题必填');
    return;
  }
  cpSaving.value = true;
  try {
    await competitorPostApi.create({
      account: cpForm.value.account.trim(),
      title: cpForm.value.title.trim(),
      ...(cpForm.value.likesCount !== null ? { likesCount: cpForm.value.likesCount } : {}),
      ...(cpForm.value.commentsCount !== null ? { commentsCount: cpForm.value.commentsCount } : {}),
      ...(cpForm.value.activityType.trim()
        ? { activityType: cpForm.value.activityType.trim() }
        : {}),
    });
    ElMessage.success('已录入');
    cpDialog.value = false;
    await loadCompetitor();
  } finally {
    cpSaving.value = false;
  }
}

function onTabChange(name: string | number): void {
  if (name === 'content' && records.value.length === 0 && !contentLoading.value) void loadRecords();
  if (name === 'competitor' && !cpBoard.value && !cpLoading.value) void loadCompetitor();
  if (name === 'inspiration' && !insLoaded.value && !insLoading.value) void loadInspirations();
}

// —— 灵感库（M02 批次B）：爆款参考沉淀——手动录入 / AI 拆解粘贴 / 联网扫描，
// 存量灵感由后端在选题与脚本生成时自动注入参考（前端只管录入与浏览） ——
const INSPIRATION_PLATFORMS = ['抖音', '视频号', '快手', '其他'];

interface InspirationFormState {
  platform: string;
  title: string;
  hookText: string;
  structure: string;
  rhythm: string;
  metrics: string;
  tags: string[];
  isPeer: boolean;
  sourceUrl: string;
  note: string;
}

function emptyInspirationForm(): InspirationFormState {
  return {
    platform: '抖音',
    title: '',
    hookText: '',
    structure: '',
    rhythm: '',
    metrics: '',
    tags: [],
    isPeer: false,
    sourceUrl: '',
    note: '',
  };
}

const inspirations = ref<VideoInspiration[]>([]);
const insLoading = ref(false);
const insLoaded = ref(false);
const insFilter = ref({ keyword: '', platform: '', isPeerOnly: false, status: '' });
/** 选题卡统计行（拉一次）：灵感库共 N 条（同行 M 条）——active 口径（候选不计入） */
const insStats = ref<{ total: number; peer: number } | null>(null);

async function loadInspirations(): Promise<void> {
  insLoading.value = true;
  try {
    inspirations.value = await inspirationApi.list({
      ...(insFilter.value.keyword.trim() ? { keyword: insFilter.value.keyword.trim() } : {}),
      ...(insFilter.value.platform ? { platform: insFilter.value.platform } : {}),
      ...(insFilter.value.isPeerOnly ? { isPeer: true } : {}),
      ...(insFilter.value.status ? { status: insFilter.value.status } : {}),
    });
    insLoaded.value = true;
  } finally {
    insLoading.value = false;
  }
}

async function loadInspirationStats(): Promise<void> {
  try {
    const rows = await inspirationApi.list();
    const active = rows.filter((r) => r.status === 'active');
    insStats.value = { total: active.length, peer: active.filter((r) => r.isPeer).length };
  } catch {
    // 统计行拉取失败静默——不影响选题/脚本生成本身
  }
}

// —— 录入（手动表单 + AI 拆解确认共用创建路径） ——
const insDialog = ref(false);
const insSaving = ref(false);
const insForm = ref<InspirationFormState>(emptyInspirationForm());

function openInsDialog(): void {
  insForm.value = emptyInspirationForm();
  insDialog.value = true;
}

async function createInspiration(f: InspirationFormState): Promise<void> {
  await inspirationApi.create({
    platform: f.platform,
    title: f.title.trim(),
    hookText: f.hookText.trim(),
    structure: f.structure.trim(),
    ...(f.rhythm.trim() ? { rhythm: f.rhythm.trim() } : {}),
    ...(f.metrics.trim() ? { metrics: f.metrics.trim() } : {}),
    tags: f.tags,
    isPeer: f.isPeer,
    ...(f.sourceUrl.trim() ? { sourceUrl: f.sourceUrl.trim() } : {}),
    note: f.note.trim() || undefined,
  });
}

async function submitInspiration(): Promise<void> {
  const f = insForm.value;
  if (!f.title.trim() || !f.hookText.trim() || !f.structure.trim()) {
    ElMessage.warning('标题、钩子拆解与结构拆解必填');
    return;
  }
  insSaving.value = true;
  try {
    await createInspiration(f);
    ElMessage.success('已录入灵感库——生成选题/脚本时会自动参考');
    insDialog.value = false;
    await loadInspirations();
    await loadInspirationStats();
  } finally {
    insSaving.value = false;
  }
}

// —— 归档/恢复 + 编辑备注标签（更新面仅 note/tags/status，拆解字段是原文快照） ——
async function toggleInspirationStatus(row: VideoInspiration): Promise<void> {
  await inspirationApi.update(row.id, {
    status: row.status === 'active' ? 'archived' : 'active',
  });
  ElMessage.success(
    row.status === 'active' ? '已归档（不再注入 AI 参考，仍可翻查）' : '已恢复（重新参与 AI 参考）',
  );
  await loadInspirations();
  await loadInspirationStats();
}

// —— 候选采纳/忽略（T4 每日自动扫描配套）：自动扫描只落 candidate 建议态，
// 人点头才转正式（active 参与注入）或不留待办（archived 可翻查）——m02:edit 门控
async function adoptCandidate(row: VideoInspiration): Promise<void> {
  await inspirationApi.adopt(row.id);
  ElMessage.success('已采纳——生成选题/脚本时会自动参考');
  await loadInspirations();
  await loadInspirationStats();
}

async function dismissCandidate(row: VideoInspiration): Promise<void> {
  await inspirationApi.dismiss(row.id);
  ElMessage.success('已忽略（归档保留，可翻查）');
  await loadInspirations();
}

const insEditDialog = ref(false);
const insEditSaving = ref(false);
const insEditForm = ref<{ id: string; title: string; tags: string[]; note: string }>({
  id: '',
  title: '',
  tags: [],
  note: '',
});

function openInsEditDialog(row: VideoInspiration): void {
  insEditForm.value = { id: row.id, title: row.title, tags: [...row.tags], note: row.note ?? '' };
  insEditDialog.value = true;
}

async function submitInspirationEdit(): Promise<void> {
  insEditSaving.value = true;
  try {
    await inspirationApi.update(insEditForm.value.id, {
      tags: insEditForm.value.tags,
      note: insEditForm.value.note.trim(),
    });
    ElMessage.success('已更新备注与标签');
    insEditDialog.value = false;
    await loadInspirations();
    await loadInspirationStats();
  } finally {
    insEditSaving.value = false;
  }
}

// —— AI 拆解：粘贴爆款原文 → 拆解建议预览（可改）→ 确认入库 ——
const dissectDialog = ref(false);
const dissectLoading = ref(false);
const dissectSaving = ref(false);
const dissectRaw = ref('');
const dissectPlatform = ref('抖音');
const dissectIsPeer = ref(false);
const dissectForm = ref<InspirationFormState | null>(null);

function openDissectDialog(): void {
  dissectRaw.value = '';
  dissectForm.value = null;
  dissectDialog.value = true;
}

async function runDissect(): Promise<void> {
  if (dissectRaw.value.trim().length < 20) {
    ElMessage.warning('原文至少 20 字（粘贴视频文案/描述/评论区数据）');
    return;
  }
  dissectLoading.value = true;
  try {
    const res = await inspirationApi.dissect({
      rawText: dissectRaw.value.trim(),
      platform: dissectPlatform.value,
      isPeer: dissectIsPeer.value,
    });
    dissectForm.value = {
      platform: dissectPlatform.value,
      title: '',
      hookText: res.dissect.hookText,
      structure: res.dissect.structure,
      rhythm: res.dissect.rhythm ?? '',
      metrics: '',
      tags: res.dissect.tags.slice(0, 6),
      isPeer: dissectIsPeer.value,
      sourceUrl: '',
      note: res.dissect.takeaway ? `可借鉴：${res.dissect.takeaway}` : '',
    };
    ElMessage.success('拆解完成——核对结果、补上标题后入库');
  } finally {
    dissectLoading.value = false;
  }
}

async function submitDissected(): Promise<void> {
  const f = dissectForm.value;
  if (!f) return;
  if (!f.title.trim() || !f.hookText.trim() || !f.structure.trim()) {
    ElMessage.warning('标题、钩子拆解与结构拆解必填');
    return;
  }
  dissectSaving.value = true;
  try {
    await createInspiration(f);
    ElMessage.success('已录入灵感库——生成选题/脚本时会自动参考');
    dissectDialog.value = false;
    await loadInspirations();
    await loadInspirationStats();
  } finally {
    dissectSaving.value = false;
  }
}

// —— 扫描爆款文章：联网搜近一周行业爆款公开分析 → 候选预览（勾选+可改）→ 批量入库 ——
interface ScanCandidate extends InspirationScanItem {
  checked: boolean;
}

const scanDialog = ref(false);
const scanLoading = ref(false);
const scanSaving = ref(false);
const scanNote = ref<string | null>(null);
const scanCandidates = ref<ScanCandidate[]>([]);
const pickedCount = computed(() => scanCandidates.value.filter((c) => c.checked).length);

function openScanDialog(): void {
  scanDialog.value = true;
  if (scanCandidates.value.length === 0 && !scanLoading.value) void runScan();
}

async function runScan(): Promise<void> {
  scanLoading.value = true;
  scanCandidates.value = [];
  scanNote.value = null;
  try {
    const res = await inspirationApi.scan();
    scanCandidates.value = res.items.map((item) => ({ ...item, checked: true }));
    scanNote.value = res.scanNote;
    if (res.items.length === 0) ElMessage.info('本次扫描未发现值得入库的候选（宁缺毋滥）');
  } finally {
    scanLoading.value = false;
  }
}

async function submitScanImport(): Promise<void> {
  const picked = scanCandidates.value.filter((c) => c.checked && c.title.trim());
  const skipped = scanCandidates.value.filter((c) => c.checked && !c.title.trim()).length;
  if (picked.length === 0) {
    ElMessage.warning('请至少勾选一条标题非空的候选');
    return;
  }
  if (skipped > 0) ElMessage.warning(`已跳过 ${skipped} 条标题为空的候选`);
  scanSaving.value = true;
  try {
    for (const c of picked) {
      await createInspiration({
        platform: c.platform,
        title: c.title.trim(),
        hookText: c.hookText,
        structure: c.structure,
        rhythm: c.rhythm ?? '',
        metrics: c.metrics ?? '',
        tags: c.tags,
        isPeer: false,
        sourceUrl: c.sourceUrl ?? '',
        note: '',
      });
    }
    ElMessage.success(`已入库 ${picked.length} 条灵感`);
    scanDialog.value = false;
    await loadInspirations();
    await loadInspirationStats();
  } finally {
    scanSaving.value = false;
  }
}

// —— 短视频运营工作台（2026-09-04 升级）：账号定位 → 选题包 → 脚本生成 ——
// 定位是账号的"身份证"（后端有按门店情况拟的默认草稿，老板改后落库）；
// 选题包手动按钮生成（联网扫热点→按定位筛选），人挑选题后带入脚本生成。
const EMPTY_POSITIONING = {
  storePositioning: '',
  targetAudience: '',
  persona: '',
  pillars: [] as string[],
  resources: '',
  tone: '',
};
const vpForm = ref({ ...EMPTY_POSITIONING });
const vpLoaded = ref(false);
const vpSaving = ref(false);
const positioningDialog = ref(false);

async function loadPositioning(): Promise<void> {
  try {
    vpForm.value = await marketingApi.getVideoPositioning();
  } finally {
    vpLoaded.value = true;
  }
}

function openPositioningDialog(): void {
  positioningDialog.value = true;
}

/** 内容支柱编辑：标签可删、输入框回车添加（上限 8 条与后端校验一致） */
const newPillar = ref('');
function addPillar(): void {
  const v = newPillar.value.trim();
  if (!v || vpForm.value.pillars.length >= 8) return;
  if (!vpForm.value.pillars.includes(v)) vpForm.value.pillars.push(v);
  newPillar.value = '';
}

async function savePositioning(): Promise<void> {
  vpSaving.value = true;
  try {
    vpForm.value = await marketingApi.saveVideoPositioning(vpForm.value);
    ElMessage.success('账号定位已保存（选题与脚本生成将按新定位工作）');
    positioningDialog.value = false;
  } finally {
    vpSaving.value = false;
  }
}

const vtLoading = ref(false);
const vtTopics = ref<VideoTopic[]>([]);
const vtHotNote = ref<string | null>(null);
const vtDateKey = ref('');
/** 当前带入选题：非空时脚本生成按其钩子方向/参考结构创作 */
const activeTopic = ref<VideoTopic | null>(null);

async function loadTopics(silent = true): Promise<void> {
  try {
    const res = await marketingApi.getVideoTopics();
    if (res) {
      vtTopics.value = res.topics.topics;
      vtHotNote.value = res.topics.hotNote;
      vtDateKey.value = '';
    } else if (!silent) {
      vtTopics.value = [];
      vtHotNote.value = null;
    }
  } catch {
    // 复看失败静默（生成按钮会重新拉取）
  }
}

async function generateTopics(): Promise<void> {
  vtLoading.value = true;
  try {
    const res = await marketingApi.generateVideoTopics();
    vtTopics.value = res.topics.topics;
    vtHotNote.value = res.topics.hotNote;
    ElMessage.success(`已生成 ${res.topics.topics.length} 个选题建议，挑选后写脚本`);
  } finally {
    vtLoading.value = false;
  }
}

function useTopic(t: VideoTopic): void {
  activeTopic.value = t;
  vcForm.value.topic = t.title;
  ElMessage.success('已带入选题，往下滚动到「脚本生成」调整参数后生成');
}

function clearTopic(): void {
  activeTopic.value = null;
}

const vcForm = ref({
  topic: '',
  productModel: '',
  carModel: '',
  style: '专业可信',
  durationSec: 30,
});
const vcLoading = ref(false);
const vcDraft = ref<VideoCopyDraft | null>(null);

const runVideoCopy = async () => {
  if (!vcForm.value.topic.trim()) {
    ElMessage.warning('请先填写视频主题（或从上方选题包带入选题）');
    return;
  }
  vcLoading.value = true;
  vcDraft.value = null;
  try {
    const t = activeTopic.value;
    const res = await marketingApi.videoCopy({
      topic: vcForm.value.topic,
      productModel: vcForm.value.productModel || undefined,
      carModel: vcForm.value.carModel || undefined,
      style: vcForm.value.style,
      durationSec: vcForm.value.durationSec,
      ...(t
        ? {
            topicContext: {
              angle: t.angle,
              reason: t.reason,
              hookDirection: t.hookDirection,
              structure: t.structure,
              type: t.type,
              source: t.source ?? undefined,
            },
          }
        : {}),
    });
    vcDraft.value = res.draft;
  } finally {
    vcLoading.value = false;
  }
};

const copyText = async (text: string) => {
  await navigator.clipboard.writeText(text);
  ElMessage.success('已复制（注意：已复制≠已发送，发布前请人工核对边界）');
};

void loadPositioning();
void loadTopics();
// 选题卡统计行（拉一次）；深链直开灵感库页签时也拉列表
void loadInspirationStats();
if (tab.value === 'inspiration') void loadInspirations();

// —— 同行整理 ——
const cnForm = ref({ sourceText: '', sourcePlatform: '抖音' });
const cnLoading = ref(false);
const cnResult = ref<CompetitorNotesResult | null>(null);

const runCompetitorNotes = async () => {
  if (cnForm.value.sourceText.trim().length < 30) {
    ElMessage.warning('原文至少 30 字');
    return;
  }
  cnLoading.value = true;
  cnResult.value = null;
  try {
    cnResult.value = await marketingApi.competitorNotes({
      sourceText: cnForm.value.sourceText,
      sourcePlatform: cnForm.value.sourcePlatform || undefined,
    });
    ElMessage.success('已整理为知识库草稿（同行信息），待人工审核生效');
  } finally {
    cnLoading.value = false;
  }
};

const KIND_LABEL: Record<string, string> = {
  price: '价格',
  activity: '活动',
  selling_point: '卖点',
  channel: '渠道',
  other: '其他',
};
</script>

<template>
  <div class="marketing wg-page">
    <PageHeader title="经营任务" sub="短视频文案草稿 + 同行信息整理（AI 只出草稿，人执行）" />
    <el-alert
      type="info"
      :closable="false"
      title="AI 输出均为草稿态：文案采用后由人拍摄发布；同行整理仅录入人工浏览的公开内容（不做自动抓取），结果进知识库草稿待审核"
      class="marketing__alert"
    />
    <!-- 页签下划线随全局主色令牌（--el-color-primary=#0066cc） -->
    <el-tabs v-model="tab" class="marketing__tabs" @tab-change="onTabChange">
      <el-tab-pane label="🎬 短视频文案" name="video">
        <div v-if="can('m02:edit') || can('m02:approve')" class="video-workflow">
          <!-- ① 账号定位：短视频账号的"身份证"，选题筛选与脚本生成都会用到 -->
          <div class="wg-card">
            <div class="video-workflow__card-head">
              <h3 class="wg-card-title">① 账号定位<WgHintIcon k="marketing.videoPositioning" /></h3>
              <el-button round size="small" @click="openPositioningDialog"
                >查看 / 修改定位</el-button
              >
            </div>
            <el-descriptions
              v-if="vpLoaded"
              :column="1"
              border
              size="small"
              class="video-workflow__pos"
            >
              <el-descriptions-item label="门店定位">{{
                vpForm.storePositioning
              }}</el-descriptions-item>
              <el-descriptions-item label="目标人群">{{
                vpForm.targetAudience
              }}</el-descriptions-item>
              <el-descriptions-item label="账号人设">{{ vpForm.persona }}</el-descriptions-item>
              <el-descriptions-item label="内容支柱">
                <el-tag
                  v-for="p in vpForm.pillars"
                  :key="p"
                  size="small"
                  class="video-workflow__pillar"
                  >{{ p }}</el-tag
                >
              </el-descriptions-item>
              <el-descriptions-item v-if="vpForm.tone" label="口吻">{{
                vpForm.tone
              }}</el-descriptions-item>
            </el-descriptions>
          </div>

          <!-- ② 选题工作台：扫热点→按定位筛选→选题建议（人挑选后才进入创作） -->
          <div class="wg-card">
            <div class="video-workflow__card-head">
              <h3 class="wg-card-title">② 今日选题<WgHintIcon k="marketing.videoTopic" /></h3>
              <el-button type="primary" round :loading="vtLoading" @click="generateTopics">
                {{ vtTopics.length > 0 ? '重新生成选题' : '生成今日选题' }}
              </el-button>
            </div>
            <p v-if="insStats !== null" class="wg-muted video-workflow__ins-stat">
              灵感库共 {{ insStats.total }} 条（同行 {{ insStats.peer }} 条）可供参考——{{
                insStats.total > 0
                  ? '生成选题与脚本时会自动挑相近的爆款注入，无需手动选择'
                  : '去「💡 灵感库」录入爆款参考，选题与脚本更有据可依'
              }}
            </p>
            <p class="wg-muted video-workflow__hint">
              像运营一样选题：联网搜近 1~2 天热点与汽车/贴膜行业动态，按账号定位筛选能借势的，
              再补常青选题——约需 1~2 分钟。选题是建议，挑哪个你说了算。
            </p>
            <p v-if="vtHotNote" class="wg-muted video-workflow__hotnote">
              热点扫描：{{ vtHotNote }}
            </p>
            <el-empty
              v-if="!vtLoading && vtTopics.length === 0"
              description="今天还没生成选题——点上方按钮开始"
            />
            <div v-else class="video-workflow__topics">
              <div
                v-for="t in vtTopics"
                :key="t.title"
                class="video-workflow__topic"
                :class="{ 'is-active': activeTopic?.title === t.title }"
              >
                <div class="video-workflow__topic-head">
                  <el-tag size="small" :type="t.type === 'hot' ? 'danger' : 'info'">
                    {{ t.type === 'hot' ? '热点借势' : '常青选题' }}
                  </el-tag>
                  <el-tag size="small" type="warning" effect="plain"
                    >拍摄难度：{{ t.difficulty }}</el-tag
                  >
                  <strong class="video-workflow__topic-title">{{ t.title }}</strong>
                </div>
                <p><span class="video-workflow__label">切入角度</span>{{ t.angle }}</p>
                <p><span class="video-workflow__label">选题理由</span>{{ t.reason }}</p>
                <p><span class="video-workflow__label">钩子方向</span>{{ t.hookDirection }}</p>
                <p><span class="video-workflow__label">参考结构</span>{{ t.structure }}</p>
                <p v-if="t.source" class="wg-muted">
                  热点来源：{{ t.source }}（来自公开网络，仅供参考）
                </p>
                <el-button
                  round
                  size="small"
                  :type="activeTopic?.title === t.title ? 'success' : 'primary'"
                  @click="useTopic(t)"
                >
                  {{ activeTopic?.title === t.title ? '✓ 已带入选题' : '用此选题写脚本' }}
                </el-button>
              </div>
            </div>
          </div>

          <!-- ③ 脚本生成：带选题时按其钩子方向/参考结构创作 -->
          <div class="wg-card">
            <h3 class="wg-card-title">③ 脚本生成<WgHintIcon k="marketing.videoCopy" /></h3>
            <el-alert
              v-if="activeTopic"
              type="success"
              :closable="false"
              class="video-workflow__active-topic"
            >
              <template #title>
                当前选题：{{ activeTopic.title }}（{{
                  activeTopic.type === 'hot' ? '热点借势' : '常青'
                }}） —— 将按其钩子方向与参考结构创作
                <el-button link type="primary" size="small" @click="clearTopic">清除选题</el-button>
              </template>
            </el-alert>
            <el-form label-width="90px" style="max-width: 560px">
              <el-form-item label="主题" required>
                <el-input
                  v-model="vcForm.topic"
                  placeholder="如：夏天车内像蒸笼？前挡膜到底有没有用（或从上方选题带入选题）"
                />
              </el-form-item>
              <el-form-item label="产品型号">
                <el-input
                  v-model="vcForm.productModel"
                  placeholder="如 DM04（自动带出知识库素材）"
                />
              </el-form-item>
              <el-form-item label="车型">
                <el-input v-model="vcForm.carModel" placeholder="可选" />
              </el-form-item>
              <el-form-item label="风格">
                <el-radio-group v-model="vcForm.style">
                  <el-radio-button value="专业可信">专业可信</el-radio-button>
                  <el-radio-button value="轻松日常">轻松日常</el-radio-button>
                  <el-radio-button value="接地气">接地气</el-radio-button>
                </el-radio-group>
              </el-form-item>
              <el-form-item label="时长(秒)">
                <el-input-number v-model="vcForm.durationSec" :min="15" :max="180" :step="15" />
              </el-form-item>
              <el-button
                type="primary"
                round
                :loading="vcLoading"
                :disabled="!vcForm.topic.trim()"
                @click="runVideoCopy"
              >
                生成文案草稿
              </el-button>
            </el-form>
            <div v-if="vcDraft" class="draft">
              <h3>{{ vcDraft.title }}</h3>
              <p class="hook">钩子：{{ vcDraft.hook }}</p>
              <pre class="script">{{ vcDraft.script }}</pre>
              <p class="wg-muted">话题标签：{{ vcDraft.hashtags.join(' ') }}</p>
              <p class="wg-muted">素材来源：{{ vcDraft.sourceRefs.join('；') || '（无）' }}</p>
              <el-button
                round
                size="small"
                @click="
                  copyText(`${vcDraft.title}\n\n${vcDraft.script}\n\n${vcDraft.hashtags.join(' ')}`)
                "
              >
                复制全文
              </el-button>
            </div>
          </div>
        </div>
        <el-alert
          v-else
          type="warning"
          :closable="false"
          title="无操作权限（需运营/店长/老板角色）"
        />

        <!-- 账号定位编辑弹窗：改完保存，选题与脚本生成即按新定位工作 -->
        <el-dialog
          v-model="positioningDialog"
          title="账号定位（选题与脚本生成的依据）"
          width="640px"
          append-to-body
        >
          <el-form label-width="90px">
            <el-form-item label="门店定位" required>
              <el-input
                v-model="vpForm.storePositioning"
                type="textarea"
                :rows="2"
                placeholder="如：本地本地高端汽车膜专营店……"
              />
            </el-form-item>
            <el-form-item label="目标人群" required>
              <el-input
                v-model="vpForm.targetAudience"
                type="textarea"
                :rows="2"
                placeholder="如：本地本地 20 万以上车主为主……"
              />
            </el-form-item>
            <el-form-item label="账号人设" required>
              <el-input
                v-model="vpForm.persona"
                type="textarea"
                :rows="2"
                placeholder="如：真人 IP——老板出镜讲专业，技师第一视角拍施工"
              />
            </el-form-item>
            <el-form-item label="内容支柱" required>
              <div class="video-workflow__pillars">
                <el-tag
                  v-for="(p, i) in vpForm.pillars"
                  :key="i"
                  closable
                  @close="vpForm.pillars.splice(i, 1)"
                >
                  {{ p }}
                </el-tag>
                <el-input
                  v-if="vpForm.pillars.length < 8"
                  v-model="newPillar"
                  size="small"
                  style="width: 220px"
                  placeholder="添加支柱后回车"
                  @keyup.enter="addPillar"
                />
              </div>
            </el-form-item>
            <el-form-item label="拍摄资源">
              <el-input
                v-model="vpForm.resources"
                type="textarea"
                :rows="2"
                placeholder="能拍什么：如门店实拍为主，技师出镜可安排，不摆拍剧情"
              />
            </el-form-item>
            <el-form-item label="口吻">
              <el-input v-model="vpForm.tone" placeholder="如：本地老板口吻——实在、不吹牛" />
            </el-form-item>
          </el-form>
          <p class="wg-muted video-workflow__hint">
            定位是账号的"身份证"：AI 选题时按它筛热点、写脚本时按它定口吻。改完保存即生效。
          </p>
          <template #footer>
            <el-button round @click="positioningDialog = false">取消</el-button>
            <el-button
              type="primary"
              round
              :loading="vpSaving"
              :disabled="vpForm.pillars.length === 0"
              @click="savePositioning"
            >
              保存定位
            </el-button>
          </template>
        </el-dialog>
      </el-tab-pane>

      <el-tab-pane label="💡 灵感库" name="inspiration">
        <div class="wg-card">
          <div class="video-workflow__card-head">
            <h3 class="wg-card-title">爆款参考灵感<WgHintIcon k="marketing.inspiration" /></h3>
            <div v-if="can('m02:edit') || can('m02:approve')" class="inspiration__head-actions">
              <el-button round size="small" :loading="scanLoading" @click="openScanDialog">
                扫描爆款文章
              </el-button>
              <el-button round size="small" @click="openDissectDialog">AI 拆解录入</el-button>
              <el-button type="primary" round size="small" @click="openInsDialog">
                手动录入
              </el-button>
            </div>
          </div>
          <p class="wg-muted video-workflow__hint">
            刷到好视频别只点赞——拆进来变成可复用的参考：钩子怎么抓人、结构怎么组织、节奏怎么带。
            存量灵感会在生成选题与脚本时自动注入参考（后端按内容支柱挑相近的，归档的不参与）。
            系统每天还会自动扫描爆款文章落为「候选」——采纳后才参与 AI 参考。
          </p>
          <div class="inspiration__filters">
            <el-select
              v-model="insFilter.platform"
              clearable
              placeholder="平台（全部）"
              style="width: 130px"
              @change="loadInspirations"
            >
              <el-option v-for="p in INSPIRATION_PLATFORMS" :key="p" :label="p" :value="p" />
            </el-select>
            <el-select
              v-model="insFilter.status"
              clearable
              placeholder="状态（全部）"
              style="width: 120px"
              @change="loadInspirations"
            >
              <el-option label="使用中" value="active" />
              <el-option label="候选" value="candidate" />
              <el-option label="已归档" value="archived" />
            </el-select>
            <el-switch
              v-model="insFilter.isPeerOnly"
              active-text="仅同行"
              @change="loadInspirations"
            />
            <el-input
              v-model="insFilter.keyword"
              placeholder="关键词（命中标题或钩子）"
              clearable
              style="width: 220px"
              @keyup.enter="loadInspirations"
              @clear="loadInspirations"
            />
            <el-button round @click="loadInspirations">筛选</el-button>
          </div>
          <el-empty
            v-if="!insLoading && inspirations.length === 0"
            description="灵感库还是空的——点「AI 拆解录入」拆一条，或「扫描爆款文章」找一批"
          />
          <div v-else v-loading="insLoading" class="inspiration__grid">
            <div
              v-for="row in inspirations"
              :key="row.id"
              class="inspiration__card"
              :class="{
                'is-archived': row.status === 'archived',
                'is-candidate': row.status === 'candidate',
              }"
            >
              <div class="inspiration__card-head">
                <el-tag size="small">{{ row.platform }}</el-tag>
                <el-tag v-if="row.isPeer" size="small" type="warning" effect="plain">同行</el-tag>
                <el-tag v-if="row.status === 'candidate'" size="small" type="success">
                  候选
                </el-tag>
                <el-tag v-if="row.status === 'archived'" size="small" type="info">已归档</el-tag>
                <strong class="inspiration__title">{{ row.title }}</strong>
              </div>
              <p><span class="video-workflow__label">钩子</span>{{ row.hookText }}</p>
              <p><span class="video-workflow__label">结构</span>{{ row.structure }}</p>
              <p v-if="row.rhythm">
                <span class="video-workflow__label">节奏</span>{{ row.rhythm }}
              </p>
              <div v-if="row.tags.length > 0" class="inspiration__tags">
                <el-tag
                  v-for="t in row.tags"
                  :key="t"
                  size="small"
                  effect="plain"
                  class="inspiration__tag"
                  >{{ t }}</el-tag
                >
              </div>
              <p v-if="row.metrics" class="wg-muted">数据：{{ row.metrics }}</p>
              <p v-if="row.note" class="wg-muted">备注：{{ row.note }}</p>
              <a
                v-if="row.sourceUrl"
                :href="row.sourceUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="inspiration__source"
                >来源链接</a
              >
              <!-- 候选卡（自动扫描落的建议态）：采纳/忽略（m02:edit，比普通编辑面窄） -->
              <div v-if="row.status === 'candidate' && can('m02:edit')" class="inspiration__ops">
                <el-button type="primary" round size="small" @click="adoptCandidate(row)">
                  采纳
                </el-button>
                <el-button round size="small" @click="dismissCandidate(row)">忽略</el-button>
              </div>
              <!-- 正式/归档卡：编辑备注标签 + 归档/恢复 -->
              <div v-else-if="can('m02:edit') || can('m02:approve')" class="inspiration__ops">
                <el-button round size="small" @click="openInsEditDialog(row)">
                  编辑备注/标签
                </el-button>
                <el-button round size="small" @click="toggleInspirationStatus(row)">
                  {{ row.status === 'active' ? '归档' : '恢复' }}
                </el-button>
              </div>
            </div>
          </div>
          <p class="wg-muted inspiration__order-hint">
            候选排在使用中之后、已归档的沉在列表底部——归档只是不再注入 AI 参考，翻查无妨
          </p>
        </div>
      </el-tab-pane>

      <el-tab-pane label="🔍 同行信息整理" name="competitor">
        <div v-if="can('m02:edit') || can('m02:approve')" class="wg-card">
          <h3 class="wg-card-title">
            整理为知识库草稿<WgHintIcon k="marketing.competitorNotes" />
          </h3>
          <el-form label-width="90px">
            <el-form-item label="来源平台">
              <el-select v-model="cnForm.sourcePlatform" style="width: 160px">
                <el-option label="抖音" value="抖音" />
                <el-option label="小红书" value="小红书" />
                <el-option label="视频号" value="视频号" />
                <el-option label="美团" value="美团" />
                <el-option label="其他/未注明" value="" />
              </el-select>
            </el-form-item>
            <el-form-item label="公开内容">
              <el-input
                v-model="cnForm.sourceText"
                type="textarea"
                :rows="8"
                placeholder="人工浏览同行的公开评论区/主页/活动页后，把看到的内容粘贴到这里（AI 只提炼粘贴文本中的事实）"
              />
            </el-form-item>
            <el-button type="primary" round :loading="cnLoading" @click="runCompetitorNotes">
              整理为知识草稿
            </el-button>
          </el-form>
          <div v-if="cnResult" class="draft">
            <h3>提炼结果（已入知识库草稿·同行信息）</h3>
            <p>{{ cnResult.notes.summary }}</p>
            <ul>
              <li v-for="(p, i) in cnResult.notes.points" :key="i">
                <el-tag size="small" style="margin-right: 6px">{{
                  KIND_LABEL[p.kind] ?? p.kind
                }}</el-tag>
                {{ p.content }}
              </li>
            </ul>
            <p v-if="cnResult.notes.caution" class="wg-muted">注意：{{ cnResult.notes.caution }}</p>
            <p class="wg-muted">去知识库页（类别=同行信息）审核生效；生效前不参与对外检索</p>
          </div>
        </div>
        <el-alert
          v-else
          type="warning"
          :closable="false"
          title="无操作权限（需运营/店长/老板角色）"
        />
      </el-tab-pane>

      <el-tab-pane label="📋 内容台账" name="content">
        <WgHintIcon k="marketing.content" />
        <div class="marketing__toolbar">
          <el-button @click="loadRecords">刷新</el-button>
          <el-button
            v-if="can('m02:edit') || can('m02:approve')"
            type="primary"
            @click="openContentDialog"
          >
            登记内容
          </el-button>
        </div>
        <el-table v-loading="contentLoading" :data="records">
          <el-table-column prop="title" label="标题" min-width="160" show-overflow-tooltip />
          <el-table-column
            prop="contentKey"
            label="内容编号"
            min-width="120"
            show-overflow-tooltip
          />
          <el-table-column prop="platform" label="平台" width="90" />
          <el-table-column label="发布时间" width="110">
            <template #default="{ row }">
              {{
                (row as ContentRecord).publishedAt
                  ? new Date((row as ContentRecord).publishedAt!).toLocaleDateString('zh-CN')
                  : '—'
              }}
            </template>
          </el-table-column>
          <el-table-column label="投流费" width="90" align="right">
            <template #default="{ row }">¥{{ fenToYuan((row as ContentRecord).costFen) }}</template>
          </el-table-column>
          <el-table-column prop="viewsCount" label="播放" width="80" align="right" />
          <el-table-column prop="likesCount" label="点赞" width="80" align="right" />
          <el-table-column prop="commentsCount" label="评论" width="80" align="right" />
          <el-table-column label="操作" width="110">
            <template #default="{ row }">
              <el-button
                v-if="can('m02:edit') || can('m02:approve')"
                size="small"
                @click="openUpdateDialog(row as ContentRecord)"
              >
                更新数据
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="📊 同行效果对比" name="board">
        <div class="marketing__toolbar">
          <el-button @click="loadCompetitor">刷新</el-button>
          <el-button
            v-if="can('m02:edit') || can('m02:approve')"
            type="primary"
            @click="cpDialog = true"
          >
            录入同行动态
          </el-button>
        </div>
        <template v-if="cpBoard">
          <el-table
            :data="[...cpBoard.competitors, { account: '我们', ...cpBoard.ours }]"
            size="small"
            border
          >
            <el-table-column prop="account" label="账号" min-width="140" />
            <el-table-column prop="posts" label="内容数" width="90" align="right" />
            <el-table-column prop="totalLikes" label="总点赞" width="100" align="right" />
            <el-table-column prop="topLikes" label="单条最高赞" width="110" align="right" />
          </el-table>
        </template>
        <el-divider content-position="left">近期动态（人工录入 + 爬虫自动填充）</el-divider>
        <el-table v-loading="cpLoading" :data="cpPosts" size="small">
          <el-table-column prop="account" label="同行账号" min-width="120" />
          <el-table-column prop="title" label="标题" min-width="180" show-overflow-tooltip />
          <el-table-column prop="likesCount" label="点赞" width="80" align="right" />
          <el-table-column prop="commentsCount" label="评论" width="80" align="right" />
          <el-table-column prop="activityType" label="类型" width="80" />
          <el-table-column label="来源" width="80">
            <template #default="{ row }">
              {{ (row as CompetitorPost).source === 'crawler' ? '爬虫' : '人工' }}
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="contentDialog" title="登记内容" width="480px">
      <el-form label-width="90px">
        <el-form-item label="内容编号">
          <el-input
            v-model="contentForm.contentKey"
            placeholder="与客资导入的内容编号一致即可归因"
            maxlength="200"
          />
        </el-form-item>
        <el-form-item label="标题">
          <el-input v-model="contentForm.title" maxlength="200" />
        </el-form-item>
        <el-form-item label="平台">
          <el-input
            v-model="contentForm.platform"
            placeholder="抖音/小红书等（选填）"
            maxlength="50"
          />
        </el-form-item>
        <el-form-item label="发布时间">
          <el-date-picker v-model="contentForm.publishedAt" type="date" value-format="YYYY-MM-DD" />
        </el-form-item>
        <el-form-item label="投流费（元）">
          <el-input-number v-model="contentForm.costYuan" :min="0" :precision="2" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="contentForm.note" maxlength="1000" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="contentDialog = false">取消</el-button>
        <el-button type="primary" :loading="contentSaving" @click="submitContent">登记</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="updateDialog" :title="`更新数据：${updateForm.title}`" width="440px">
      <el-form label-width="90px">
        <el-form-item label="播放"
          ><el-input-number v-model="updateForm.viewsCount" :min="0"
        /></el-form-item>
        <el-form-item label="点赞"
          ><el-input-number v-model="updateForm.likesCount" :min="0"
        /></el-form-item>
        <el-form-item label="评论"
          ><el-input-number v-model="updateForm.commentsCount" :min="0"
        /></el-form-item>
        <el-form-item label="投流费（元）"
          ><el-input-number v-model="updateForm.costYuan" :min="0" :precision="2"
        /></el-form-item>
        <el-form-item label="备注"
          ><el-input v-model="updateForm.note" maxlength="1000"
        /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="updateDialog = false">取消</el-button>
        <el-button type="primary" :loading="updateSaving" @click="submitUpdate">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="cpDialog" title="录入同行动态" width="440px">
      <el-form label-width="80px">
        <el-form-item label="同行账号"
          ><el-input v-model="cpForm.account" maxlength="100"
        /></el-form-item>
        <el-form-item label="标题"
          ><el-input v-model="cpForm.title" maxlength="300"
        /></el-form-item>
        <el-form-item label="点赞"
          ><el-input-number v-model="cpForm.likesCount" :min="0"
        /></el-form-item>
        <el-form-item label="评论"
          ><el-input-number v-model="cpForm.commentsCount" :min="0"
        /></el-form-item>
        <el-form-item label="类型"
          ><el-input v-model="cpForm.activityType" placeholder="优惠/新品/案例/日常" maxlength="50"
        /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="cpDialog = false">取消</el-button>
        <el-button type="primary" :loading="cpSaving" @click="submitCp">录入</el-button>
      </template>
    </el-dialog>

    <!-- 灵感库：手动录入（拆解四要素中节奏可空；入库后拆解字段不可改） -->
    <el-dialog v-model="insDialog" title="手动录入灵感" width="640px">
      <el-form label-width="90px">
        <el-form-item label="平台" required>
          <el-select v-model="insForm.platform" style="width: 140px">
            <el-option v-for="p in INSPIRATION_PLATFORMS" :key="p" :label="p" :value="p" />
          </el-select>
          <el-checkbox v-model="insForm.isPeer" class="inspiration__peer-check">
            同行作品
          </el-checkbox>
        </el-form-item>
        <el-form-item label="标题" required>
          <el-input v-model="insForm.title" maxlength="200" placeholder="这条爆款的标题/主题" />
        </el-form-item>
        <el-form-item label="钩子拆解" required>
          <el-input
            v-model="insForm.hookText"
            type="textarea"
            :rows="2"
            maxlength="2000"
            placeholder="开头怎么抓人的——如：前 3 秒直接抛「贴膜被坑 2 万？」"
          />
        </el-form-item>
        <el-form-item label="结构拆解" required>
          <el-input
            v-model="insForm.structure"
            type="textarea"
            :rows="3"
            maxlength="2000"
            placeholder="内容怎么组织的——如：痛点场景 → 翻车案例 → 正确做法 → 行动引导"
          />
        </el-form-item>
        <el-form-item label="节奏拆解">
          <el-input
            v-model="insForm.rhythm"
            type="textarea"
            :rows="2"
            maxlength="2000"
            placeholder="可空——如：每 5 秒一个信息点，中段两次反转"
          />
        </el-form-item>
        <el-form-item label="数据">
          <el-input
            v-model="insForm.metrics"
            maxlength="200"
            placeholder="可空——如：50w 赞 / 1.2w 评"
          />
        </el-form-item>
        <el-form-item label="标签">
          <el-select
            v-model="insForm.tags"
            multiple
            filterable
            allow-create
            default-first-option
            :multiple-limit="6"
            placeholder="与内容支柱对齐的短标签，输入后回车添加（最多 6 个）"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="来源链接">
          <el-input
            v-model="insForm.sourceUrl"
            maxlength="500"
            placeholder="可空——视频/文章地址，方便回看"
          />
        </el-form-item>
        <el-form-item label="备注">
          <el-input
            v-model="insForm.note"
            type="textarea"
            :rows="2"
            maxlength="1000"
            placeholder="可空——我们店能借鉴什么"
          />
        </el-form-item>
      </el-form>
      <p class="wg-muted video-workflow__hint">
        钩子/结构/节奏是录入时的原文快照，入库后不可改（改了就对不上原视频）；备注与标签随时可改。
      </p>
      <template #footer>
        <el-button round @click="insDialog = false">取消</el-button>
        <el-button type="primary" round :loading="insSaving" @click="submitInspiration">
          录入
        </el-button>
      </template>
    </el-dialog>

    <!-- 灵感库：编辑备注/标签（更新面仅 note/tags/status） -->
    <el-dialog v-model="insEditDialog" :title="`编辑备注/标签：${insEditForm.title}`" width="520px">
      <el-form label-width="90px">
        <el-form-item label="标签">
          <el-select
            v-model="insEditForm.tags"
            multiple
            filterable
            allow-create
            default-first-option
            :multiple-limit="6"
            placeholder="输入后回车添加（最多 6 个）"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="备注">
          <el-input
            v-model="insEditForm.note"
            type="textarea"
            :rows="3"
            maxlength="1000"
            placeholder="我们店能借鉴什么/拍摄注意点"
          />
        </el-form-item>
      </el-form>
      <p class="wg-muted video-workflow__hint">
        拆解内容（钩子/结构/节奏）是原文快照不可改——拆错了请归档后重新录入。
      </p>
      <template #footer>
        <el-button round @click="insEditDialog = false">取消</el-button>
        <el-button type="primary" round :loading="insEditSaving" @click="submitInspirationEdit">
          保存
        </el-button>
      </template>
    </el-dialog>

    <!-- 灵感库：AI 拆解两段式——粘贴原文 → 拆解建议预览（可改）→ 确认入库 -->
    <el-dialog v-model="dissectDialog" title="AI 拆解爆款" width="680px">
      <template v-if="!dissectForm">
        <el-form label-width="90px">
          <el-form-item label="平台">
            <el-select v-model="dissectPlatform" style="width: 140px">
              <el-option v-for="p in INSPIRATION_PLATFORMS" :key="p" :label="p" :value="p" />
            </el-select>
            <el-checkbox v-model="dissectIsPeer" class="inspiration__peer-check">
              同行作品
            </el-checkbox>
          </el-form-item>
          <el-form-item label="爆款原文">
            <el-input
              v-model="dissectRaw"
              type="textarea"
              :rows="8"
              maxlength="5000"
              show-word-limit
              placeholder="把刷到的好视频的文案/描述/评论区数据粘贴进来（至少 20 字）——AI 只拆解粘贴的文本，不做抓取"
            />
          </el-form-item>
        </el-form>
        <p class="wg-muted video-workflow__hint">
          拆解结果是 AI 的建议（钩子/结构/节奏/标签 + 一句借鉴点）——先预览、可改，确认后才入库。
        </p>
      </template>
      <template v-else>
        <el-form label-width="90px">
          <el-form-item label="平台" required>
            <el-select v-model="dissectForm.platform" style="width: 140px">
              <el-option v-for="p in INSPIRATION_PLATFORMS" :key="p" :label="p" :value="p" />
            </el-select>
            <el-checkbox v-model="dissectForm.isPeer" class="inspiration__peer-check">
              同行作品
            </el-checkbox>
          </el-form-item>
          <el-form-item label="标题" required>
            <el-input
              v-model="dissectForm.title"
              maxlength="200"
              placeholder="必填——给这条爆款起个标题（拆解不生成标题）"
            />
          </el-form-item>
          <el-form-item label="钩子拆解" required>
            <el-input
              v-model="dissectForm.hookText"
              type="textarea"
              :rows="2"
              maxlength="2000"
              placeholder="钩子拆解（来自 AI，可改）"
            />
          </el-form-item>
          <el-form-item label="结构拆解" required>
            <el-input
              v-model="dissectForm.structure"
              type="textarea"
              :rows="3"
              maxlength="2000"
              placeholder="结构拆解（来自 AI，可改）"
            />
          </el-form-item>
          <el-form-item label="节奏拆解">
            <el-input
              v-model="dissectForm.rhythm"
              type="textarea"
              :rows="2"
              maxlength="2000"
              placeholder="节奏拆解（来自 AI，可改，可清空）"
            />
          </el-form-item>
          <el-form-item label="数据">
            <el-input
              v-model="dissectForm.metrics"
              maxlength="200"
              placeholder="可空——如：50w 赞 / 1.2w 评"
            />
          </el-form-item>
          <el-form-item label="标签">
            <el-select
              v-model="dissectForm.tags"
              multiple
              filterable
              allow-create
              default-first-option
              :multiple-limit="6"
              placeholder="已按拆解预填，可增删（最多 6 个）"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="来源链接">
            <el-input
              v-model="dissectForm.sourceUrl"
              maxlength="500"
              placeholder="可空——视频地址"
            />
          </el-form-item>
          <el-form-item label="备注">
            <el-input
              v-model="dissectForm.note"
              type="textarea"
              :rows="2"
              maxlength="1000"
              placeholder="我们店能借鉴什么（拆解的借鉴点已带入，可改）"
            />
          </el-form-item>
        </el-form>
      </template>
      <template #footer>
        <el-button round @click="dissectDialog = false">取消</el-button>
        <el-button
          v-if="!dissectForm"
          type="primary"
          round
          :loading="dissectLoading"
          :disabled="dissectRaw.trim().length < 20"
          @click="runDissect"
        >
          开始拆解（约 1~2 分钟）
        </el-button>
        <template v-else>
          <el-button round @click="dissectForm = null">重新粘贴</el-button>
          <el-button type="primary" round :loading="dissectSaving" @click="submitDissected">
            确认入库
          </el-button>
        </template>
      </template>
    </el-dialog>

    <!-- 灵感库：扫描爆款文章——联网候选预览（勾选+可改标题/平台/标签）→ 批量入库 -->
    <el-dialog v-model="scanDialog" title="扫描爆款文章" width="760px">
      <el-alert
        v-if="scanLoading"
        type="info"
        :closable="false"
        title="联网搜索近一周贴膜/汽车后市场爆款公开分析——约需 2~4 分钟，请勿关闭窗口"
      />
      <template v-else>
        <p v-if="scanNote" class="wg-muted video-workflow__hint">扫描说明：{{ scanNote }}</p>
        <el-empty
          v-if="scanCandidates.length === 0"
          description="本次扫描没有发现候选——可点「重新扫描」再试（宁缺毋滥）"
        />
        <div v-else class="inspiration__scan-list">
          <div v-for="(c, i) in scanCandidates" :key="i" class="inspiration__scan-item">
            <div class="inspiration__scan-head">
              <el-checkbox v-model="c.checked" />
              <el-select
                v-model="c.platform"
                filterable
                allow-create
                size="small"
                style="width: 110px"
              >
                <el-option v-for="p in INSPIRATION_PLATFORMS" :key="p" :label="p" :value="p" />
              </el-select>
              <el-input
                v-model="c.title"
                size="small"
                maxlength="200"
                placeholder="标题（可改）"
                class="inspiration__scan-title"
              />
            </div>
            <p class="inspiration__scan-line">
              <span class="video-workflow__label">钩子</span>{{ c.hookText }}
            </p>
            <p class="inspiration__scan-line">
              <span class="video-workflow__label">结构</span>{{ c.structure }}
            </p>
            <p v-if="c.rhythm" class="inspiration__scan-line">
              <span class="video-workflow__label">节奏</span>{{ c.rhythm }}
            </p>
            <p v-if="c.metrics" class="wg-muted inspiration__scan-line">数据：{{ c.metrics }}</p>
            <el-select
              v-model="c.tags"
              multiple
              filterable
              allow-create
              default-first-option
              :multiple-limit="6"
              size="small"
              placeholder="标签（可改，回车添加）"
              style="width: 100%"
            />
            <a
              v-if="c.sourceUrl"
              :href="c.sourceUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="inspiration__source"
              >来源链接</a
            >
          </div>
        </div>
      </template>
      <template #footer>
        <el-button round @click="scanDialog = false">取消</el-button>
        <el-button v-if="!scanLoading" round :loading="scanLoading" @click="runScan">
          重新扫描
        </el-button>
        <el-button
          v-if="!scanLoading"
          type="primary"
          round
          :loading="scanSaving"
          :disabled="pickedCount === 0"
          @click="submitScanImport"
        >
          入库选中 {{ pickedCount }} 条
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.marketing__alert {
  margin-bottom: 16px;
}
/* 短视频运营工作台（2026-09-04）：三段卡片纵向流——定位→选题→脚本 */
.video-workflow {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.video-workflow__card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.video-workflow__hint {
  margin: 0 0 12px;
  font-size: 12.5px;
  line-height: 1.6;
}
.video-workflow__hotnote {
  margin: 0 0 12px;
  font-size: 12.5px;
  padding: 8px 12px;
  background: var(--wg-canvas);
  border-radius: 8px;
}
.video-workflow__pos {
  max-width: 720px;
}
.video-workflow__pillar {
  margin: 0 6px 6px 0;
}
.video-workflow__topics {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}
.video-workflow__topic {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid var(--wg-hairline);
  border-radius: 12px;
  background: var(--wg-canvas);
}
.video-workflow__topic.is-active {
  border-color: var(--el-color-success);
  box-shadow: 0 0 0 1px var(--el-color-success);
}
.video-workflow__topic p {
  margin: 2px 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--wg-ink);
}
.video-workflow__topic-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.video-workflow__topic-title {
  font-size: 14.5px;
}
.video-workflow__label {
  flex-shrink: 0;
  margin-right: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  color: var(--wg-ink-muted);
  background: var(--wg-surface);
  border: 1px solid var(--wg-hairline);
}
.video-workflow__active-topic {
  margin-bottom: 14px;
}
/* 选题卡统计行（批次B Task 3）：灵感库可供参考的存量规模 */
.video-workflow__ins-stat {
  margin: 8px 0 4px;
  font-size: 12.5px;
}
.video-workflow__pillars {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
/* 结果区与草稿排版（V2.5 令牌：pre 卡片化 + 次要文字灰） */
.draft {
  margin-top: 20px;
  border-top: 1px solid var(--wg-divider-soft);
  padding-top: 16px;
}
.draft h3 {
  font-size: 17px;
  font-weight: 600;
  margin-bottom: 8px;
}
.hook {
  color: var(--wg-ink-muted);
  font-size: 14px;
}
.script {
  white-space: pre-wrap;
  font-family: inherit;
  font-size: 15px;
  line-height: 1.6;
  background: var(--wg-canvas);
  border: 1px solid var(--wg-hairline);
  border-radius: 12px;
  padding: 14px;
}

/* —— 灵感库（批次B Task 3）：卡片网格沿用选题卡 auto-fill 自适应模式 —— */
.inspiration__head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.inspiration__filters {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 0 0 12px;
}
.inspiration__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}
.inspiration__card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid var(--wg-hairline);
  border-radius: 12px;
  background: var(--wg-canvas);
}
.inspiration__card.is-archived {
  opacity: 0.62;
}
/* 候选卡（自动扫描建议态）：虚线边框区分——看着像「待定」，与正式/归档区分开 */
.inspiration__card.is-candidate {
  border-style: dashed;
  border-color: var(--el-color-success-light-5, #95d475);
}
.inspiration__card p {
  margin: 2px 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--wg-ink);
}
.inspiration__card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.inspiration__title {
  font-size: 14.5px;
}
.inspiration__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.inspiration__ops {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.inspiration__source {
  font-size: 12.5px;
  color: var(--el-color-primary);
}
.inspiration__order-hint {
  margin: 12px 0 0;
  font-size: 12.5px;
}
.inspiration__peer-check {
  margin-left: 16px;
}
.inspiration__scan-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 56vh;
  overflow-y: auto;
}
.inspiration__scan-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--wg-hairline);
  border-radius: 12px;
  background: var(--wg-canvas);
}
.inspiration__scan-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  width: 100%;
}
.inspiration__scan-title {
  flex: 1;
  min-width: 220px;
}
.inspiration__scan-line {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--wg-ink);
}
</style>
