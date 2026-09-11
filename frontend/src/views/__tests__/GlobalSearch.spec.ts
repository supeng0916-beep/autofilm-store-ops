import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';

import { searchApi, type SearchResponse } from '../../api/search';
import GlobalSearch from '../../components/search/GlobalSearch.vue';

// mock 搜索与详情 api（AssistantChat.spec 模式）：组件不发真实请求
vi.mock('../../api/search', () => ({
  searchApi: {
    search: vi.fn(),
  },
}));
vi.mock('../../api/knowledge', () => ({
  knowledgeApi: { get: vi.fn() },
}));
vi.mock('../../api/workOrder', () => ({
  workOrderApi: { get: vi.fn() },
  WO_STAGE_LABEL: {
    pending: '待入场',
    in_progress: '施工中',
    self_check_done: '自检完成',
    recheck_done: '复检完成',
    delivered: '已交付',
  },
}));
vi.mock('../../api/appointment', () => ({
  appointmentApi: { get: vi.fn() },
}));

import { knowledgeApi } from '../../api/knowledge';

const mocked = vi.mocked(searchApi.search);

function makeResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    q: '演示品牌',
    sections: [
      {
        type: 'leads',
        items: [{ id: 'lead-1', title: '张三 138****8000', sub: '待跟进', link: '/leads/lead-1' }],
      },
      {
        type: 'knowledge',
        items: [{ id: 'k-1', title: 'DM03 标准报价', sub: 'price v2', link: '/knowledge' }],
      },
      { type: 'workOrders', items: [] }, // 空节不应渲染
      {
        type: 'appointments',
        items: [
          {
            id: 'apt-1',
            title: '李四 DM10 施工',
            sub: '2026-08-20 10:00 工位A1',
            link: '/appointments',
          },
        ],
      },
    ],
    ...overrides,
  };
}

const wrappers: ReturnType<typeof mount>[] = [];

async function mountSearch() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div>home</div>' } },
      { path: '/leads/:id', component: { template: '<div>lead</div>' } },
      { path: '/knowledge', component: { template: '<div>knowledge</div>' } },
      { path: '/appointments', component: { template: '<div>appointments</div>' } },
      { path: '/work-orders', component: { template: '<div>work-orders</div>' } },
    ],
  });
  // teleport stub：popover 面板 teleport 到 body，stub 后渲染在组件树内可断言
  const wrapper = mount(GlobalSearch, {
    global: { plugins: [router], stubs: { teleport: true } },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  await router.isReady();
  return { wrapper, router };
}

/**
 * 输入关键词并推进防抖 400ms（fake timers）。
 * 注意：click 等 VTU trigger 必须仍在 fake 时钟下进行——
 * vi.useRealTimers() 会让时钟回拨，VTU 事件带 Date.now()+1 时间戳，
 * Vue 会按时间戳去重而丢弃「过去」的点击（详见 trigger/_vts workaround）。
 */
async function typeAndDebounce(
  wrapper: Awaited<ReturnType<typeof mountSearch>>['wrapper'],
  q: string,
) {
  await wrapper.find('input').setValue(q);
  await vi.advanceTimersByTimeAsync(400);
  await nextTick();
}

describe('GlobalSearch 全局搜索（V2.3a）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    while (wrappers.length > 0) wrappers.pop()?.unmount();
    vi.useRealTimers();
  });

  it('输入≥2字：防抖400ms后检索，面板按节分组渲染（空节不出现）', async () => {
    mocked.mockResolvedValue(makeResponse());
    const { wrapper } = await mountSearch();

    // 1 字不发请求（规避后端 422）
    await wrapper.find('input').setValue('演');
    await vi.advanceTimersByTimeAsync(400);
    expect(mocked).not.toHaveBeenCalled();

    // 未到防抖窗口（399ms）不查
    await wrapper.find('input').setValue('演示品牌');
    await vi.advanceTimersByTimeAsync(399);
    expect(mocked).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await nextTick();

    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked).toHaveBeenCalledWith('演示品牌');

    // 分组渲染：节中文标签 + 条目两行（title/sub）
    expect(wrapper.text()).toContain('客资');
    expect(wrapper.text()).toContain('知识库');
    expect(wrapper.text()).toContain('预约与排期');
    const leadItem = wrapper.find('[data-test="global-search-item-lead-1"]');
    expect(leadItem.exists()).toBe(true);
    expect(leadItem.text()).toContain('张三 138****8000');
    expect(leadItem.text()).toContain('待跟进');
    // 空节（施工单 items=[]）不应渲染节标题
    expect(wrapper.find('[data-test="global-search-panel"]').text()).not.toContain('施工单');
  });

  it('点击结果项：router.push(link) 跳转并清空输入', async () => {
    mocked.mockResolvedValue(makeResponse());
    const { wrapper, router } = await mountSearch();
    await typeAndDebounce(wrapper, '演示品牌');

    await wrapper.find('[data-test="global-search-item-lead-1"]').trigger('click');
    vi.useRealTimers();
    await flushPromises();

    expect(router.currentRoute.value.path).toBe('/leads/lead-1');
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('');
  });

  it('全部节无结果：显示「无匹配」', async () => {
    mocked.mockResolvedValue(makeResponse({ sections: [{ type: 'leads', items: [] }] }));
    const { wrapper } = await mountSearch();
    await typeAndDebounce(wrapper, '不存在的关键词');
    expect(wrapper.find('[data-test="global-search-panel"]').text()).toContain('无匹配');
  });

  it('⌘K 全局快捷键聚焦搜索框', async () => {
    const { wrapper } = await mountSearch();
    expect(document.activeElement).not.toBe(wrapper.find('input').element);
    window.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true, key: 'k' }));
    await nextTick();
    expect(document.activeElement).toBe(wrapper.find('input').element);
  });

  it('回车立即检索：不等防抖窗口（2026-08-21 门店反馈修复）', async () => {
    mocked.mockResolvedValue(makeResponse());
    const { wrapper } = await mountSearch();

    await wrapper.find('input').setValue('演示品牌');
    await wrapper.find('input').trigger('keyup', { key: 'Enter' });
    await flushPromises();
    await nextTick();

    // 未推进 400ms 防抖时钟即已发起检索
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked).toHaveBeenCalledWith('演示品牌');
    expect(wrapper.find('[data-test="global-search-panel"]').text()).toContain('张三');
  });

  it('知识结果点击：原地抽屉显示全文（不跳列表页）', async () => {
    mocked.mockResolvedValue(makeResponse());
    vi.mocked(knowledgeApi.get).mockResolvedValue({
      id: 'k-1',
      kind: 'price',
      key: 'price-band',
      title: 'DM03 标准报价',
      content: '门店窗膜组合报价 4600/5900/7100 元。',
      version: 1,
      source: '门店知识源/02-价格/门店报价.md',
      licensed: true,
      expiresAt: null,
      status: 'active',
      tags: null,
      createdBy: 'u1',
      approvedBy: 'u2',
      approvedAt: '2026-08-21T00:00:00.000Z',
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
    });
    const { wrapper, router } = await mountSearch();
    await typeAndDebounce(wrapper, '演示品牌');

    // 两次点击均在 fake 时钟下进行（useRealTimers 后 VTU 事件会被 Vue 时间戳去重丢弃）
    await wrapper.find('[data-test="global-search-item-k-1"]').trigger('click');
    await flushPromises();
    await nextTick();

    // 抽屉渲染全文与来源；路由不跳转（仍是初始页）
    expect(wrapper.find('[data-test="global-search-drawer"]').text()).toContain(
      '门店窗膜组合报价 4600/5900/7100 元。',
    );
    expect(wrapper.find('[data-test="global-search-drawer"]').text()).toContain(
      '门店知识源/02-价格/门店报价.md',
    );
    expect(router.currentRoute.value.path).toBe('/');

    // 「前往页面」逃生口仍可跳列表页
    await wrapper.find('[data-test="drawer-goto-page"]').trigger('click');
    vi.useRealTimers();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/knowledge');
  });

  it('命中片段与关键词高亮：content 命中时显示片段行，关键词加粗高亮（2026-08-21）', async () => {
    mocked.mockResolvedValue(
      makeResponse({
        sections: [
          {
            type: 'knowledge',
            items: [
              {
                id: 'k-2',
                title: '价格速查表',
                sub: 'price · active',
                link: '/knowledge',
                snippet: '…客户问价时居家膜套餐按一口价报…',
              },
            ],
          },
        ],
      }),
    );
    const { wrapper } = await mountSearch();
    await typeAndDebounce(wrapper, '居家膜');

    const panel = wrapper.find('[data-test="global-search-panel"]');
    expect(panel.text()).toContain('客户问价时居家膜套餐按一口价报'); // 片段行可见
    const hl = panel.find('.global-search__hl');
    expect(hl.exists()).toBe(true);
    expect(hl.text()).toBe('居家膜'); // 关键词被切出高亮
  });
});
