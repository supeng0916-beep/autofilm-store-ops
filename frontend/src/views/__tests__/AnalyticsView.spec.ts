import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { analyticsApi, type AnalyticsOverview } from '../../api/analytics';
import AnalyticsView from '../AnalyticsView.vue';

// mock 复盘 api（AppointmentsView.spec 同模式）：overview 逐用例指定
vi.mock('../../api/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/analytics')>();
  return { ...actual, analyticsApi: { ...actual.analyticsApi, overview: vi.fn() } };
});

const mockedOverview = vi.mocked(analyticsApi.overview);

/** 最小复盘响应夹具：仅关键字段给值，其余置空（本套件只断言毛利卡） */
function makeOverview(overrides: Partial<AnalyticsOverview> = {}): AnalyticsOverview {
  return {
    range: { from: null, to: null, scopedToOwner: false },
    funnel: {
      total: 0,
      touched: 0,
      visited: 0,
      won: 0,
      lost: 0,
      touchRate: 0,
      visitRate: 0,
      closeRate: 0,
      avgCloseDays: null,
    },
    byStage: [],
    byFinalStatus: [],
    revenueFen: 0,
    avgDealFen: null,
    bySource: [],
    lostReasons: [],
    workOrders: {
      total: 0,
      delivered: 0,
      inProgress: 0,
      reworkCount: 0,
      reworkRate: 0,
      byTechnician: [],
    },
    finance: { incomeFen: 0, expenseFen: 0, netFen: 0 },
    grossProfitFen: null,
    contentAttribution: [],
    profile: { gender: [], ageBand: [] },
    repeatCustomerCount: 0,
    ...overrides,
  };
}

async function mountView(data: AnalyticsOverview) {
  mockedOverview.mockResolvedValue(data);
  const wrapper = mount(AnalyticsView, { global: { plugins: [ElementPlus] } });
  await flushPromises();
  return wrapper;
}

describe('AnalyticsView 经营复盘（批次4 毛利估算卡）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** 锁定毛利估算 StatCard（其他卡也有 ¥0/- 文案，断言限定在卡内） */
  function profitCard(wrapper: ReturnType<typeof mount>) {
    const card = wrapper.findAll('.stat-card').find((c) => c.text().includes('毛利估算'));
    expect(card).toBeTruthy();
    return card!;
  }

  it('毛利估算卡：有值按元展示，tip 注明口径', async () => {
    const wrapper = await mountView(makeOverview({ grossProfitFen: 400_000 }));

    const card = profitCard(wrapper);
    expect(card.find('.wg-num').text()).toBe('¥4,000'); // 400000 分 ÷ 100
    expect(card.text()).toContain('口径：已录材料成本的已确认订单 收款−成本');
  });

  it('毛利估算卡：无已录成本的确认订单（null）显示"—"', async () => {
    const wrapper = await mountView(makeOverview({ grossProfitFen: null }));

    const card = profitCard(wrapper);
    expect(card.find('.wg-num').text()).toBe('—');
  });

  it('批次6 复购客户行：客户画像面板内渲染计数与口径说明', async () => {
    const wrapper = await mountView(makeOverview({ repeatCustomerCount: 3 }));

    const line = wrapper.find('.repeat-line');
    expect(line.exists()).toBe(true);
    // 数字与口径文案都在该行内（\s* 容忍模板换行冷凝产生的空格）
    expect(line.text()).toMatch(/复购客户\s*3\s*位/);
    expect(line.text()).toContain('（成交≥2 条客资）');
  });

  it('批次6 复购客户行：零复购客户渲染 0 位（不隐藏行）', async () => {
    const wrapper = await mountView(makeOverview({ repeatCustomerCount: 0 }));

    expect(wrapper.find('.repeat-line').text()).toMatch(/复购客户\s*0\s*位/);
  });
});
