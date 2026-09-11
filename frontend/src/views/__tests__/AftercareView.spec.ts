import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  aftercareApi,
  type AftercareVisit,
  type CustomerReview,
  type ReferralRecord,
  type ServiceRequest,
  type WarrantyRegistration,
} from '../../api/aftercare';
import { workOrderApi } from '../../api/workOrder';
import AftercareView from '../AftercareView.vue';

// 权限 composable 整体 mock（AppointmentsView.spec 口径）：本页写面按钮走 can('m09:edit')
const { canMock } = vi.hoisted(() => ({ canMock: vi.fn<(perm: string) => boolean>() }));
vi.mock('../../composables/usePermission', () => ({
  usePermission: () => ({ can: canMock }),
}));

// mock api 模块：常量（VISIT_PLAN_LABEL/SR_KIND_LABEL）保留原实现，仅替换端点函数
vi.mock('../../api/aftercare', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/aftercare')>();
  return {
    ...actual,
    aftercareApi: {
      visits: vi.fn(),
      createVisit: vi.fn(),
      executeVisit: vi.fn(),
      skipVisit: vi.fn(),
      serviceRequests: vi.fn(),
      createServiceRequest: vi.fn(),
      updateServiceRequest: vi.fn(),
      warranties: vi.fn(),
      createWarranty: vi.fn(),
      registerWarranty: vi.fn(),
      referrals: vi.fn(),
      createReferral: vi.fn(),
      markReferralWon: vi.fn(),
      reviews: vi.fn(),
      createReview: vi.fn(),
    },
  };
});
// 施工单下拉（新建回访用）：视图仅调 list()
vi.mock('../../api/workOrder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/workOrder')>();
  return { ...actual, workOrderApi: { list: vi.fn() } };
});

const mockedVisits = vi.mocked(aftercareApi.visits);
const mockedExecute = vi.mocked(aftercareApi.executeVisit);
const mockedRequests = vi.mocked(aftercareApi.serviceRequests);
const mockedWarranties = vi.mocked(aftercareApi.warranties);
const mockedRegisterWarranty = vi.mocked(aftercareApi.registerWarranty);
const mockedReferrals = vi.mocked(aftercareApi.referrals);
const mockedMarkReferralWon = vi.mocked(aftercareApi.markReferralWon);
const mockedReviews = vi.mocked(aftercareApi.reviews);
const mockedCreateReview = vi.mocked(aftercareApi.createReview);
const mockedWoList = vi.mocked(workOrderApi.list);

function makeVisit(overrides: Partial<AftercareVisit> = {}): AftercareVisit {
  return {
    id: 'v1',
    workOrderId: 'wo1',
    customerId: 'c1',
    plan: 'd7',
    dueAt: '2026-09-15T08:00:00.000Z',
    status: 'pending',
    executedBy: null,
    executedAt: null,
    note: null,
    createdBy: null,
    createdAt: '2026-09-01T01:00:00.000Z',
    updatedAt: '2026-09-01T01:00:00.000Z',
    ...overrides,
  };
}

function makeRequest(overrides: Partial<ServiceRequest> = {}): ServiceRequest {
  return {
    id: 's1',
    customerId: 'c1',
    leadId: null,
    workOrderId: 'wo1',
    kind: 'consult',
    content: '前挡膜边缘起泡，客户要求尽快处理',
    status: 'open',
    handlerUserId: null,
    resolvedAt: null,
    result: null,
    createdBy: null,
    createdAt: '2026-09-01T02:00:00.000Z',
    updatedAt: '2026-09-01T02:00:00.000Z',
    ...overrides,
  };
}

function makeWarranty(overrides: Partial<WarrantyRegistration> = {}): WarrantyRegistration {
  return {
    id: 'w1',
    workOrderId: 'wo1',
    customerId: 'c1',
    productModel: 'DM90',
    registrationNo: null,
    registeredAt: null,
    status: 'pending',
    note: null,
    createdBy: null,
    createdAt: '2026-09-01T03:00:00.000Z',
    updatedAt: '2026-09-01T03:00:00.000Z',
    ...overrides,
  };
}

function makeReferral(overrides: Partial<ReferralRecord> = {}): ReferralRecord {
  return {
    id: 'r1',
    referrerCustomerId: 'c1',
    referredLeadId: 'l2',
    referredCustomerId: null,
    status: 'pending',
    note: null,
    createdBy: null,
    createdAt: '2026-09-01T04:00:00.000Z',
    updatedAt: '2026-09-01T04:00:00.000Z',
    ...overrides,
  };
}

function makeReview(overrides: Partial<CustomerReview> = {}): CustomerReview {
  return {
    id: 'rv1',
    customerId: 'c1',
    leadId: null,
    workOrderId: 'wo1',
    score: 5,
    content: '贴膜师傅手艺好，边缘处理细致',
    reviewedAt: '2026-09-02T02:00:00.000Z',
    createdBy: null,
    createdAt: '2026-09-02T02:00:00.000Z',
    ...overrides,
  };
}

async function mountView(
  data: {
    visits?: AftercareVisit[];
    requests?: ServiceRequest[];
    warranties?: WarrantyRegistration[];
    referrals?: ReferralRecord[];
    reviews?: CustomerReview[];
  } = {},
  canEdit = true,
) {
  mockedVisits.mockResolvedValue(data.visits ?? []);
  mockedRequests.mockResolvedValue(data.requests ?? []);
  mockedWarranties.mockResolvedValue(data.warranties ?? []);
  mockedReferrals.mockResolvedValue(data.referrals ?? []);
  mockedReviews.mockResolvedValue(data.reviews ?? []);
  mockedWoList.mockResolvedValue([]);
  mockedExecute.mockResolvedValue(makeVisit({ status: 'done' }));
  mockedRegisterWarranty.mockResolvedValue(makeWarranty({ status: 'registered' }));
  mockedMarkReferralWon.mockResolvedValue(makeReferral({ status: 'won' }));
  mockedCreateReview.mockResolvedValue(makeReview());
  canMock.mockImplementation((perm: string) => canEdit && perm === 'm09:edit');
  const wrapper = mount(AftercareView, {
    global: {
      plugins: [ElementPlus, createPinia()],
      stubs: { teleport: true },
    },
  });
  await flushPromises();
  return wrapper;
}

describe('AftercareView 售后与回访（M09 批次1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('列表渲染：回访计划两条（7天/30天）+ 售后受理一条', async () => {
    const wrapper = await mountView({
      visits: [
        makeVisit({ id: 'v1', plan: 'd7' }),
        makeVisit({ id: 'v2', plan: 'd30', dueAt: '2026-10-01T08:00:00.000Z' }),
      ],
      requests: [makeRequest({ id: 's1', kind: 'complaint', content: '膜边起泡，客户情绪激动' })],
    });

    // 默认页签=回访计划：两条回访的计划标签均渲染
    expect(wrapper.text()).toContain('7天回访');
    expect(wrapper.text()).toContain('30天回访');

    // 切到售后受理页签：受理行可见（类型标签 + 内容摘要 + 状态）
    await wrapper.findAll('.el-tabs__item')[1]?.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('投诉');
    expect(wrapper.text()).toContain('膜边起泡，客户情绪激动');
    expect(wrapper.text()).toContain('待受理');
  });

  it(`can('m09:edit')=false 时所有写操作按钮不渲染`, async () => {
    const wrapper = await mountView({ visits: [makeVisit()], requests: [makeRequest()] }, false);
    const texts = wrapper.findAll('button').map((b) => b.text());
    for (const t of [
      '新建回访',
      '标记完成',
      '跳过',
      '新建受理',
      '领单',
      '标记解决',
      '新建质保登记',
      '登记完成',
      '新建转介绍',
      '标记成交',
      '新建评价',
    ]) {
      expect(texts).not.toContain(t);
    }
  });

  it('标记完成：调用 executeVisit 并刷新回访列表', async () => {
    const wrapper = await mountView({ visits: [makeVisit({ id: 'v9', status: 'pending' })] });
    const btn = wrapper.findAll('button').find((b) => b.text() === '标记完成');
    await btn?.trigger('click');
    await flushPromises();
    expect(mockedExecute).toHaveBeenCalledTimes(1);
    expect(mockedExecute).toHaveBeenCalledWith('v9');
    expect(mockedVisits).toHaveBeenCalledTimes(2); // 初始加载 + 操作后刷新
  });

  // I-1 配套：视图层只传 id，空请求体 {} 由 api 层补齐（契约断言在 api/__tests__/aftercare.spec）
  it('登记完成：点击后调用 registerWarranty 并刷新质保列表', async () => {
    const wrapper = await mountView({ warranties: [makeWarranty({ id: 'w9' })] });
    await wrapper.findAll('.el-tabs__item')[2]?.trigger('click');
    await flushPromises();
    const btn = wrapper.findAll('button').find((b) => b.text() === '登记完成');
    await btn?.trigger('click');
    await flushPromises();
    expect(mockedRegisterWarranty).toHaveBeenCalledTimes(1);
    expect(mockedRegisterWarranty).toHaveBeenCalledWith('w9');
    expect(mockedWarranties).toHaveBeenCalledTimes(2); // 初始加载 + 操作后刷新
  });

  it('标记成交：点击后调用 markReferralWon 并刷新转介绍列表', async () => {
    const wrapper = await mountView({ referrals: [makeReferral({ id: 'r9' })] });
    await wrapper.findAll('.el-tabs__item')[3]?.trigger('click');
    await flushPromises();
    const btn = wrapper.findAll('button').find((b) => b.text() === '标记成交');
    await btn?.trigger('click');
    await flushPromises();
    expect(mockedMarkReferralWon).toHaveBeenCalledTimes(1);
    expect(mockedMarkReferralWon).toHaveBeenCalledWith('r9');
    expect(mockedReferrals).toHaveBeenCalledTimes(2); // 初始加载 + 操作后刷新
  });

  it('客户评价页签：列表渲染评语与时间，无关联载体的客户/施工单列显 -', async () => {
    const wrapper = await mountView({
      reviews: [
        makeReview({ id: 'rv1', score: 5 }),
        makeReview({
          id: 'rv2',
          customerId: null,
          workOrderId: null,
          score: 3,
          content: null,
          reviewedAt: '2026-09-01T05:00:00.000Z',
        }),
      ],
    });

    // 第 5 个页签=客户评价
    expect(wrapper.text()).toContain('客户评价');
    await wrapper.findAll('.el-tabs__item')[4]?.trigger('click');
    await flushPromises();
    const pane = wrapper.findAll('.el-tab-pane')[4];
    expect(pane.text()).toContain('贴膜师傅手艺好，边缘处理细致');

    // 两条评价各渲染一个只读星级
    expect(pane.findAll('.el-rate').length).toBe(2);

    // 无关联载体行：客户列与施工单列显 -（评语为空同样显 -）
    const rows = pane.findAll('.el-table__row');
    expect(rows.length).toBe(2);
    const cells = rows[1].findAll('td');
    expect(cells[0].text()).toBe('-');
    expect(cells[1].text()).toBe('-');
    expect(cells[3].text()).toBe('-');
  });

  it('新建评价：评分与评语提交后调用 createReview 并刷新评价列表', async () => {
    const wrapper = await mountView();
    await wrapper.findAll('.el-tabs__item')[4]?.trigger('click');
    await flushPromises();

    const open = wrapper.findAll('button').find((b) => b.text() === '新建评价');
    await open?.trigger('click');
    await flushPromises();

    // 评分走 el-rate（AssetsUploadDialog.spec 同款：组件值经状态直改）
    const vm = wrapper.vm as unknown as { reviewForm: Record<string, unknown> };
    vm.reviewForm.score = 5;
    await wrapper.findAll('.el-dialog input.el-input__inner')[0]?.setValue('c9'); // 客户 ID（选填）
    await wrapper.find('.el-dialog textarea')?.setValue('施工仔细，交车准时');
    await flushPromises();

    const submit = wrapper.findAll('.el-dialog button').find((b) => b.text().includes('提交'));
    await submit?.trigger('click');
    await flushPromises();

    expect(mockedCreateReview).toHaveBeenCalledTimes(1);
    expect(mockedCreateReview).toHaveBeenCalledWith({
      score: 5,
      customerId: 'c9',
      content: '施工仔细，交车准时',
    });
    expect(mockedReviews).toHaveBeenCalledTimes(2); // 初始加载 + 提交后刷新
  });

  it('新建评价：未选评分时表单拦住，不调用 createReview', async () => {
    const wrapper = await mountView();
    await wrapper.findAll('.el-tabs__item')[4]?.trigger('click');
    await flushPromises();

    const open = wrapper.findAll('button').find((b) => b.text() === '新建评价');
    await open?.trigger('click');
    await flushPromises();
    await wrapper.find('.el-dialog textarea')?.setValue('只有评语没有评分');

    const submit = wrapper.findAll('.el-dialog button').find((b) => b.text().includes('提交'));
    await submit?.trigger('click');
    await flushPromises();

    expect(mockedCreateReview).not.toHaveBeenCalled();
    expect(wrapper.find('.el-dialog').exists()).toBe(true); // 对话框保留便于修改后重提
  });
});
