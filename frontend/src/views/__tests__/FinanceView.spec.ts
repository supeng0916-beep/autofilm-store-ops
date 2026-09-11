import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { financeApi } from '../../api/finance';
import { orderApi, type ArrearsRow } from '../../api/order';
import FinanceView from '../FinanceView.vue';

// mock 财务与订单 api（AnalyticsView.spec 同模式）：欠款清单逐用例指定
vi.mock('../../api/finance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/finance')>();
  return { ...actual, financeApi: { ...actual.financeApi, list: vi.fn(), create: vi.fn() } };
});
vi.mock('../../api/order', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/order')>();
  return { ...actual, orderApi: { ...actual.orderApi, arrears: vi.fn() } };
});

const mockedList = vi.mocked(financeApi.list);
const mockedCreate = vi.mocked(financeApi.create);
const mockedArrears = vi.mocked(orderApi.arrears);

/** 最小欠款行夹具：定金 3000.00 + 尾款 7000.00 → 订单总额 10000.00（分为单位存储） */
function makeArrears(overrides: Partial<ArrearsRow> = {}): ArrearsRow {
  return {
    id: 'oc1',
    leadId: 'lead-1',
    customerName: '车主冯先生',
    phone: '13800001111',
    depositFen: 300000,
    balanceFen: 700000,
    customerConfirmedAt: '2026-09-01T08:00:00.000Z',
    ...overrides,
  };
}

async function mountView(arrears: ArrearsRow[]) {
  mockedList.mockResolvedValue([]);
  mockedCreate.mockResolvedValue({} as never);
  mockedArrears.mockResolvedValue(arrears);
  const wrapper = mount(FinanceView, { global: { plugins: [ElementPlus] } });
  await flushPromises();
  return wrapper;
}

describe('FinanceView 欠款提醒面板（批次5 Task 5）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('欠款面板：一条数据各列值——客户/电话/订单总额（定金+尾款）/已收定金/待收尾款/确认时间', async () => {
    const wrapper = await mountView([makeArrears()]);

    const rows = wrapper.findAll('.finance__arrears .el-table__row');
    expect(rows).toHaveLength(1);
    const cells = rows[0]!.findAll('td');
    expect(cells[0]!.text()).toBe('车主冯先生');
    expect(cells[1]!.text()).toBe('13800001111');
    expect(cells[2]!.text()).toBe('¥10000.00'); // (300000+700000) 分 → 10000.00 元
    expect(cells[3]!.text()).toBe('¥3000.00');
    expect(cells[4]!.text()).toBe('¥7000.00');
    expect(cells[5]!.text()).toBe(new Date('2026-09-01T08:00:00.000Z').toLocaleDateString('zh-CN'));
  });

  it('欠款面板：无未收尾款时显示空态文案', async () => {
    const wrapper = await mountView([]);

    const empty = wrapper.find('.finance__arrears .el-table__empty-text');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toBe('当前无未收尾款');
  });
});
