import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { leadsApi } from '../../api/leads';
import type { TakeoverCandidate } from '../../api/takeover';
import { takeoverApi } from '../../api/takeover';
import { useAuthStore } from '../../stores/auth';
import TakeoverQueueView from '../TakeoverQueueView.vue';

// mock api 模块：仅替换端点函数
vi.mock('../../api/leads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/leads')>();
  return { ...actual, leadsApi: { takeover: vi.fn(), claim: vi.fn() } };
});
vi.mock('../../api/takeover', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/takeover')>();
  return { ...actual, takeoverApi: { getCandidates: vi.fn() } };
});

const mockedTakeover = vi.mocked(leadsApi.takeover);
const mockedList = vi.mocked(takeoverApi.getCandidates);

function makeCandidate(overrides: Partial<TakeoverCandidate> = {}): TakeoverCandidate {
  return {
    leadId: 'lead-1',
    leadNo: 'L-2026-0001',
    customerName: '王先生',
    sourcePlatform: '抖音',
    stage: 'communicating',
    intentLevel: 'high',
    ownerName: '销售乙',
    lastFollowUpAt: '2026-08-20T00:00:00.000Z',
    reasons: ['stagnant', 'high_intent'],
    priority: 0,
    ...overrides,
  };
}

async function mountView(roles: string[] = ['store_manager']) {
  const pinia = createPinia();
  const auth = useAuthStore(pinia);
  auth.roles = roles;
  auth.user = { id: 'u-manager', username: 'manager', displayName: '店长店长甲' };
  const wrapper = mount(TakeoverQueueView, {
    global: { plugins: [ElementPlus, pinia] },
  });
  await flushPromises();
  return wrapper;
}

/** 2026-08-28 UI 测试 #1：接管队列闭环——此前全页只读无接管动作 */
describe('TakeoverQueueView 接管队列（2026-08-28 UI 测试 #1 闭环补齐）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedList.mockResolvedValue([makeCandidate()]);
    mockedTakeover.mockResolvedValue({} as never);
  });

  it('店长/老板可见「接管」按钮；销售（仅查看）不显示', async () => {
    const managerView = await mountView(['store_manager']);
    expect(managerView.findAll('button').some((b) => b.text() === '接管')).toBe(true);

    const bossView = await mountView(['boss']);
    expect(bossView.findAll('button').some((b) => b.text() === '接管')).toBe(true);

    const salesView = await mountView(['sales_ops']);
    expect(salesView.findAll('button').some((b) => b.text() === '接管')).toBe(false);
    expect(salesView.text()).toContain('接管操作需店长或老板');
  });

  it('接管弹窗三要素齐填后调用 POST takeover 并刷新列表', async () => {
    const wrapper = await mountView(['store_manager']);
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '接管')
      ?.trigger('click');
    await flushPromises();

    // 三要素任一缺失 → 本地拦截
    const submit = wrapper.findAll('.el-dialog button').find((b) => b.text() === '确认接管');
    await submit?.trigger('click');
    await flushPromises();
    expect(mockedTakeover).not.toHaveBeenCalled();

    // 齐填 → 调用成功并刷新
    const setByPlaceholder = async (placeholder: string, value: string) => {
      const input = wrapper
        .findAll('.el-dialog input, .el-dialog textarea')
        .find((i) => i.attributes('placeholder')?.includes(placeholder));
      await input?.setValue(value);
    };
    await setByPlaceholder('为何需要', '高意向客户停滞 7 天需店长亲自跟');
    await setByPlaceholder('客户原话', '客户说本周来店但一直没人跟进');
    await setByPlaceholder('接管后你准备怎么做', '今天电话确认到店时间');
    await submit?.trigger('click');
    await flushPromises();

    expect(mockedTakeover).toHaveBeenCalledWith('lead-1', {
      reason: '高意向客户停滞 7 天需店长亲自跟',
      evidence: '客户说本周来店但一直没人跟进',
      nextAction: '今天电话确认到店时间',
    });
    expect(mockedList).toHaveBeenCalledTimes(2); // 挂载 1 次 + 接管成功刷新 1 次
  });
});
