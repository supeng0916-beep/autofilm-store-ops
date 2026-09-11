import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { notificationApi, type AppNotification } from '../../../api/notification';
import NotificationBell from '../NotificationBell.vue';

// mock 通知 api（AssistantChat.spec 模式）：组件轮询/列表/已读全走 mock，不发真实请求
vi.mock('../../../api/notification', () => ({
  notificationApi: {
    list: vi.fn(),
    unreadCount: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
  },
}));

const mocked = vi.mocked(notificationApi);

function makeNotification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'n1',
    kind: 'approval_pending',
    title: '新审批待办：m07.schedule.confirm',
    body: 'DM10 全车隔热膜｜2026-09-01 工位 A1',
    link: '/approvals',
    readAt: null,
    createdAt: '2026-08-19T02:00:00.000Z',
    ...overrides,
  };
}

async function mountBell() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div>home</div>' } },
      { path: '/approvals', component: { template: '<div>approvals</div>' } },
      { path: '/appointments', component: { template: '<div>appointments</div>' } },
    ],
  });
  const wrapper = mount(NotificationBell, {
    global: { plugins: [router], stubs: { teleport: true } },
  });
  await router.isReady();
  await flushPromises();
  return { wrapper, router };
}

describe('NotificationBell 通知铃铛与抽屉（V2.2a）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.unreadCount.mockResolvedValue(0);
    mocked.list.mockResolvedValue([]);
    mocked.markRead.mockResolvedValue(1);
    mocked.markAllRead.mockResolvedValue(0);
  });

  it('挂载拉未读数：>0 经角标展示，0 时隐藏', async () => {
    mocked.unreadCount.mockResolvedValue(3);
    const { wrapper } = await mountBell();
    expect(mocked.unreadCount).toHaveBeenCalledTimes(1);
    expect(wrapper.find('.el-badge__content').text()).toBe('3');
  });

  it('点击铃铛开抽屉：列表渲染 kind 中文标签，未读条目加粗（is-unread）', async () => {
    mocked.unreadCount.mockResolvedValue(2);
    mocked.list.mockResolvedValue([
      makeNotification(),
      makeNotification({
        id: 'n2',
        kind: 'appointment_confirmed',
        readAt: '2026-08-19T03:00:00.000Z',
      }),
    ]);
    const { wrapper } = await mountBell();

    await wrapper.find('[data-test="notification-bell"]').trigger('click');
    await flushPromises();

    expect(mocked.list).toHaveBeenCalledTimes(1);
    const unreadItem = wrapper.find('[data-test="notification-item-n1"]');
    expect(unreadItem.classes()).toContain('is-unread');
    expect(unreadItem.text()).toContain('审批待办'); // kind 中文标签
    // 已读条目不加粗
    expect(wrapper.find('[data-test="notification-item-n2"]').classes()).not.toContain('is-unread');
    expect(wrapper.find('[data-test="notification-item-n2"]').text()).toContain('排期确认');
  });

  it('点击未读条目：markRead 后跳转 link', async () => {
    mocked.unreadCount.mockResolvedValue(1);
    mocked.list.mockResolvedValue([makeNotification()]);
    const { wrapper, router } = await mountBell();

    await wrapper.find('[data-test="notification-bell"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="notification-item-n1"]').trigger('click');
    await flushPromises();

    expect(mocked.markRead).toHaveBeenCalledWith('n1');
    expect(router.currentRoute.value.path).toBe('/approvals');
  });

  it('点击已读条目：不重复 markRead，仍可跳转', async () => {
    mocked.list.mockResolvedValue([
      makeNotification({ readAt: '2026-08-19T03:00:00.000Z', link: '/appointments' }),
    ]);
    const { wrapper, router } = await mountBell();

    await wrapper.find('[data-test="notification-bell"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="notification-item-n1"]').trigger('click');
    await flushPromises();

    expect(mocked.markRead).not.toHaveBeenCalled();
    expect(router.currentRoute.value.path).toBe('/appointments');
  });

  it('全部已读：调 markAllRead 且角标归零', async () => {
    mocked.unreadCount.mockResolvedValue(2);
    mocked.list.mockResolvedValue([makeNotification()]);
    mocked.markAllRead.mockResolvedValue(2);
    const { wrapper } = await mountBell();

    await wrapper.find('[data-test="notification-bell"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="mark-all"]').trigger('click');
    await flushPromises();

    expect(mocked.markAllRead).toHaveBeenCalledTimes(1);
    expect(wrapper.find('.el-badge__content').exists()).toBe(false); // 0 隐藏
  });
});
