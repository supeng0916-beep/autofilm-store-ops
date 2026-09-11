import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import {
  inspirationApi,
  marketingApi,
  type VideoInspiration,
  type VideoPositioning,
} from '../../api/marketing';
import MarketingView from '../MarketingView.vue';

// mock marketing api（FinanceView.spec 同模式）：定位/选题/灵感库逐用例指定
vi.mock('../../api/marketing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/marketing')>();
  return {
    ...actual,
    marketingApi: {
      ...actual.marketingApi,
      getVideoPositioning: vi.fn(),
      getVideoTopics: vi.fn(),
    },
    inspirationApi: {
      ...actual.inspirationApi,
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      dissect: vi.fn(),
      scan: vi.fn(),
    },
  };
});
vi.mock('../../composables/usePermission', () => ({
  usePermission: () => ({ can: () => true }),
}));

// 部分 mock element-plus（LeadDetailView.spec 模式）：ElMessage 静音
const message = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('element-plus')>();
  return { ...actual, ElMessage: message };
});

const mockPositioning = vi.mocked(marketingApi.getVideoPositioning);
const mockTopics = vi.mocked(marketingApi.getVideoTopics);
const mockList = vi.mocked(inspirationApi.list);
const mockCreate = vi.mocked(inspirationApi.create);
const mockUpdate = vi.mocked(inspirationApi.update);
const mockDissect = vi.mocked(inspirationApi.dissect);
const mockScan = vi.mocked(inspirationApi.scan);

const POSITIONING: VideoPositioning = {
  storePositioning: '本地本地高端汽车膜专营店',
  targetAudience: '本地本地 20 万以上车主',
  persona: '老板出镜讲专业',
  pillars: ['产品科普', '施工过程'],
  resources: '门店实拍',
  tone: '实在、不吹牛',
};

function makeInspiration(overrides: Partial<VideoInspiration> = {}): VideoInspiration {
  return {
    id: 'ins-1',
    platform: '抖音',
    title: '贴膜被坑两万块？',
    hookText: '前 3 秒直接抛「贴膜被坑 2 万？」',
    structure: '痛点场景 → 翻车案例 → 正确做法 → 行动引导',
    rhythm: '每 5 秒一个信息点',
    metrics: '50w 赞 / 1.2w 评',
    tags: ['避坑', '产品科普'],
    isPeer: false,
    sourceUrl: 'https://example.com/v/1',
    note: '借鉴点：用翻车案例开场',
    status: 'active',
    createdBy: 'u1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 三条夹具：2 条 active（其中 1 条同行）+ 1 条 archived（统计只算 active） */
const ROWS: VideoInspiration[] = [
  makeInspiration({ id: 'ins-a', isPeer: true, title: '同行爆款：全车隔热膜实测' }),
  makeInspiration({ id: 'ins-b', platform: '视频号', title: '改色膜色差翻车现场' }),
  makeInspiration({
    id: 'ins-c',
    platform: '快手',
    title: '旧爆款（已归档）',
    status: 'archived',
  }),
];

async function mountView(tab?: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/marketing', component: MarketingView }],
  });
  router.push(tab ? `/marketing?tab=${tab}` : '/marketing');
  await router.isReady();
  mockPositioning.mockResolvedValue(POSITIONING);
  mockTopics.mockResolvedValue(null);
  mockList.mockResolvedValue(ROWS);
  mockCreate.mockResolvedValue(ROWS[0]!);
  mockUpdate.mockResolvedValue(ROWS[0]!);
  const wrapper = mount(MarketingView, { global: { plugins: [ElementPlus, router] } });
  await flushPromises();
  return wrapper;
}

/** 按可见文本找按钮（el-button 渲染为原生 button） */
function buttonByText(wrapper: VueWrapper, text: string) {
  return wrapper.findAll('button').find((b) => b.text().includes(text));
}

describe('MarketingView 灵感库（M02 批次B Task 3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('选题卡统计行：灵感库共 N 条（同行 M 条）——active 口径，归档不计', async () => {
    const wrapper = await mountView();
    const stat = wrapper.find('.video-workflow__ins-stat');
    expect(stat.exists()).toBe(true);
    expect(stat.text()).toContain('灵感库共 2 条（同行 1 条）');
  });

  it('灵感库页签：卡片渲染平台/标题/钩子/结构/标签/同行标记/数据/备注/来源链接，归档带标记', async () => {
    const wrapper = await mountView('inspiration');
    const cards = wrapper.findAll('.inspiration__card');
    expect(cards).toHaveLength(3);

    const peer = cards[0]!;
    expect(peer.find('.el-tag').text()).toBe('抖音');
    expect(peer.text()).toContain('同行爆款：全车隔热膜实测');
    expect(peer.text()).toContain('前 3 秒直接抛「贴膜被坑 2 万？」');
    expect(peer.text()).toContain('痛点场景 → 翻车案例 → 正确做法 → 行动引导');
    expect(peer.text()).toContain('避坑');
    expect(peer.find('.el-tag--warning').text()).toBe('同行');
    expect(peer.text()).toContain('数据：50w 赞 / 1.2w 评');
    expect(peer.text()).toContain('借鉴点：用翻车案例开场');
    expect(peer.find('a.inspiration__source').attributes('href')).toBe('https://example.com/v/1');

    const archived = cards[2]!;
    expect(archived.classes()).toContain('is-archived');
    expect(archived.text()).toContain('已归档');
  });

  it('筛选条：关键词筛选透传给 list（命中标题或钩子由后端执行）', async () => {
    const wrapper = await mountView('inspiration');
    mockList.mockClear();
    await wrapper.find('.inspiration__filters input[placeholder^="关键词"]').setValue('贴膜');
    await buttonByText(wrapper, '筛选')!.trigger('click');
    await flushPromises();
    expect(mockList).toHaveBeenLastCalledWith({ keyword: '贴膜' });
  });

  it('归档：点卡片「归档」→ PATCH status=archived 并刷新列表', async () => {
    const wrapper = await mountView('inspiration');
    mockUpdate.mockClear();
    mockList.mockClear();
    const ops = wrapper.findAll('.inspiration__card .inspiration__ops')[0]!;
    await ops.findAll('button')[1]!.trigger('click');
    await flushPromises();
    expect(mockUpdate).toHaveBeenCalledWith('ins-a', { status: 'archived' });
    expect(mockList).toHaveBeenCalled();
  });

  it('手动录入：必填齐后 create 以表单值入库并刷新', async () => {
    const wrapper = await mountView('inspiration');
    mockCreate.mockClear();
    mockList.mockClear();
    await buttonByText(wrapper, '手动录入')!.trigger('click');
    await flushPromises();

    await wrapper.find('input[placeholder^="这条爆款的标题"]').setValue('本地车主必看的隔热膜科普');
    await wrapper.find('textarea[placeholder^="开头怎么抓人"]').setValue('夏天车内像蒸笼？');
    await wrapper.find('textarea[placeholder^="内容怎么组织"]').setValue('痛点→原理→实测→引导');
    const footer = wrapper.find('.el-dialog__footer');
    await footer.findAll('button')[1]!.trigger('click');
    await flushPromises();

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: '抖音',
        title: '本地车主必看的隔热膜科普',
        hookText: '夏天车内像蒸笼？',
        structure: '痛点→原理→实测→引导',
        tags: [],
        isPeer: false,
      }),
    );
    expect(mockList).toHaveBeenCalled();
  });

  it('AI 拆解两段式：粘贴→dissect→结果预填可编辑表单（含 takeaway 入备注）→确认入库', async () => {
    const wrapper = await mountView('inspiration');
    mockDissect.mockResolvedValue({
      taskId: 't1',
      dissect: {
        hookText: '开头甩出 2 万块学费',
        structure: '翻车案例 → 避坑清单',
        rhythm: null,
        tags: ['避坑', '行业揭秘'],
        takeaway: '用真实翻车案例建立可信度',
      },
    });
    mockCreate.mockClear();
    await buttonByText(wrapper, 'AI 拆解录入')!.trigger('click');
    await flushPromises();

    const raw =
      '刷到一条爆款：贴膜被坑两万块，评论区都在问怎么避坑，文案开头直接抛出痛点，中段讲翻车案例，结尾给行动引导。';
    await wrapper.find('textarea[placeholder^="把刷到的好视频"]').setValue(raw);
    await buttonByText(wrapper, '开始拆解')!.trigger('click');
    await flushPromises();

    expect(mockDissect).toHaveBeenCalledWith({ rawText: raw, platform: '抖音', isPeer: false });
    // 预填阶段：钩子来自拆解结果，takeaway 进备注，标题留人补
    const hook = wrapper.find('textarea[placeholder^="钩子拆解（来自 AI"]');
    expect((hook.element as HTMLTextAreaElement).value).toBe('开头甩出 2 万块学费');
    const note = wrapper.find('textarea[placeholder^="我们店能借鉴什么"]');
    expect((note.element as HTMLTextAreaElement).value).toContain(
      '可借鉴：用真实翻车案例建立可信度',
    );

    await wrapper.find('input[placeholder^="必填——给这条爆款"]').setValue('贴膜避坑爆款拆解');
    await buttonByText(wrapper, '确认入库')!.trigger('click');
    await flushPromises();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: '抖音',
        title: '贴膜避坑爆款拆解',
        hookText: '开头甩出 2 万块学费',
        structure: '翻车案例 → 避坑清单',
        tags: ['避坑', '行业揭秘'],
        note: '可借鉴：用真实翻车案例建立可信度',
      }),
    );
  });

  it('扫描爆款文章：候选全勾选默认入库，取消勾选的跳过', async () => {
    const wrapper = await mountView('inspiration');
    mockScan.mockResolvedValue({
      taskId: 't2',
      items: [
        {
          platform: '抖音',
          title: '本周爆款一：隔热膜实测',
          hookText: '钩子一',
          structure: '结构一',
          rhythm: null,
          metrics: null,
          tags: ['实测'],
          sourceUrl: null,
        },
        {
          platform: '视频号',
          title: '本周爆款二：改色翻车',
          hookText: '钩子二',
          structure: '结构二',
          rhythm: null,
          metrics: null,
          tags: [],
          sourceUrl: null,
        },
      ],
      scanNote: '来自公开分析文章',
    });
    mockCreate.mockClear();
    await buttonByText(wrapper, '扫描爆款文章')!.trigger('click');
    await flushPromises();
    expect(mockScan).toHaveBeenCalledTimes(1);

    const items = wrapper.findAll('.inspiration__scan-item');
    expect(items).toHaveLength(2);
    // 取消第二条勾选（el-checkbox 原生 input change → v-model）
    await items[1]!.find('.el-checkbox input').setValue(false);
    await flushPromises();
    expect(buttonByText(wrapper, '入库选中')!.text()).toContain('入库选中 1 条');

    await buttonByText(wrapper, '入库选中')!.trigger('click');
    await flushPromises();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: '本周爆款一：隔热膜实测', tags: ['实测'] }),
    );
  });
});
