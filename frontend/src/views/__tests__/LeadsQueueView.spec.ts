import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import LeadsQueueView from '../LeadsQueueView.vue';

// mock api：页面不发真实请求，list 行为逐用例指定（与 LeadImportView.spec 同模式）
const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  contactAttempt: vi.fn(),
  customerReply: vi.fn(),
}));
vi.mock('../../api/leads', () => ({ leadsApi: api }));

const ASSIGNED = {
  id: 'l1',
  leadNo: 'L-20260814-0001',
  customerName: '张三',
  sourcePlatform: '抖音',
  intentLevel: 'high',
  stage: 'new',
  finalStatus: 'active',
  ownerUserId: 'u1',
  nextStep: '电话首触达',
  receivedAt: '2026-08-14T09:00:00.000Z',
  firstContactAttemptAt: null,
  sla: { state: 'ok', dueInMinutes: 15 },
};

const UNASSIGNED = {
  id: 'l2',
  leadNo: 'L-20260814-0002',
  customerName: '李四',
  sourcePlatform: '4S店',
  intentLevel: 'mid',
  stage: 'new',
  finalStatus: 'active',
  ownerUserId: null,
  nextStep: null,
  receivedAt: '2026-08-14T09:00:00.000Z',
  firstContactAttemptAt: null,
  sla: { state: 'remind', dueInMinutes: 8 },
};

async function mountView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  });
  const wrapper = mount(LeadsQueueView, {
    global: { plugins: [ElementPlus, router] },
  });
  await flushPromises();
  return wrapper;
}

describe('LeadsQueueView 客资队列（P3-03 前端）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染倒计时文案：已分配 15 分钟、未分配 8 分钟（≤10 分钟红色）', async () => {
    api.list.mockResolvedValue([ASSIGNED, UNASSIGNED]);
    const wrapper = await mountView();

    expect(api.list).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('15 分钟');
    expect(wrapper.text()).toContain('8 分钟');

    // 8 分钟 ≤10 触发红色危险样式，15 分钟不触发
    const danger = wrapper.findAll('.lead-sla--danger');
    expect(danger).toHaveLength(1);
  });

  it('未分配客资行高亮：row-class-name 挂 lead-row--unassigned', async () => {
    api.list.mockResolvedValue([ASSIGNED, UNASSIGNED]);
    const wrapper = await mountView();

    const highlighted = wrapper.findAll('.lead-row--unassigned');
    expect(highlighted).toHaveLength(1);
    expect(wrapper.text()).toContain('未分配');
  });

  it('已违约/已触达状态文案渲染', async () => {
    api.list.mockResolvedValue([
      { ...ASSIGNED, sla: { state: 'breach', dueInMinutes: 0 } },
      { ...UNASSIGNED, sla: { state: 'done', dueInMinutes: null } },
    ]);
    const wrapper = await mountView();

    expect(wrapper.text()).toContain('已违约');
    expect(wrapper.text()).toContain('已触达');
  });

  it('列表加载失败不重复弹错误（由 http 拦截器统一弹出）', async () => {
    api.list.mockRejectedValue(new Error('boom'));
    const wrapper = await mountView();

    expect(api.list).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).not.toContain('boom');
  });
});
