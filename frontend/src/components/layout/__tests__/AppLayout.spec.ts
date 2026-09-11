import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus, { ElMessage } from 'element-plus';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import type { AiStatus } from '../../../api/ai';
import { changePassword } from '../../../api/auth';
import { useAuthStore } from '../../../stores/auth';
import AppLayout from '../AppLayout.vue';

// mock ai api：布局挂载即启动轮询，测试不发真实请求，状态逐用例指定
const fetchAiStatus = vi.hoisted(() => vi.fn());
vi.mock('../../../api/ai', () => ({ fetchAiStatus }));
// mock 通知 api（V2.2a）：品牌行铃铛挂载即拉未读数，同样不发真实请求
const notificationApi = vi.hoisted(() => ({ unreadCount: vi.fn() }));
vi.mock('../../../api/notification', () => ({ notificationApi }));
// mock 改密 api（任务书 #11）：login/fetchMe 保留原实现（本文件 store 状态直灌，不发请求）
vi.mock('../../../api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/auth')>();
  return { ...actual, changePassword: vi.fn() };
});
const mockedChangePassword = vi.mocked(changePassword);

// mountLayout 内部创建的 pinia/router 实例：用例需要直接断言 store action 与路由跳转
let layoutPinia: ReturnType<typeof createPinia> | null = null;
let layoutRouter: ReturnType<typeof createRouter> | null = null;

function makeStatus(overrides: Partial<AiStatus> = {}): AiStatus {
  return {
    globalEnabled: true,
    healthy: true,
    lastHealthyAt: '2026-08-13T00:00:00.000Z',
    lastError: null,
    skills: [{ taskType: 'hello', enabled: true }],
    notice: null,
    ...overrides,
  };
}

/** 挂载布局并注入指定权限点（模拟 /auth/me 返回的 permissions）。
 * teleportStub=true 时改密对话框内容渲染在组件树内（el-dialog 默认传送 body，stub 后可 wrapper.find） */
async function mountLayout(permissions: string[], teleportStub = false) {
  const pinia = createPinia();
  layoutPinia = pinia; // 供用例直接取 auth store（如 spy logout）
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div>home</div>' } },
      { path: '/login', component: { template: '<div>login</div>' } },
    ],
  });
  layoutRouter = router;
  const wrapper = mount(AppLayout, {
    global: {
      plugins: [ElementPlus, router, pinia],
      stubs: teleportStub ? { teleport: true } : {},
    },
  });
  const auth = useAuthStore(pinia);
  auth.permissions = permissions;
  // V2.6：顶栏账号区依赖 /auth/me 水合的 user（router 守卫保证登录后有值）
  auth.user = { id: 'u-001', username: 'boss', displayName: '张店长' };
  await router.push('/');
  await router.isReady();
  await flushPromises(); // 等待 status 首次轮询落定
  return wrapper;
}

/** 取承载改密对话框的 overlay（页面还有铃铛/消息等其他 overlay，须按内容过滤） */
function dialogOverlay(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.el-overlay').find((o) => o.find('.el-dialog').exists());
}

describe('AppLayout 工作台布局（P1-02 权限过滤菜单）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchAiStatus.mockResolvedValue(makeStatus());
    notificationApi.unreadCount.mockResolvedValue(0);
  });

  it('渲染品牌名与顶栏标题', async () => {
    const wrapper = await mountLayout([]);
    // 2026-08-26 品牌行拆分为 strong+small（审查 #2 对齐）：分别断言两段
    expect(wrapper.text()).toContain('AutoFilm Demo');
    expect(wrapper.text()).toContain('门店工作台');
    expect(wrapper.text()).toContain('AI经营协同系统');
  });

  it('悬浮 AI 助手浮球（2026-08-26 老板设计）：右下角 V 浮球存在，点击后挂载对话抽屉组件', async () => {
    const wrapper = await mountLayout([]);
    const btn = wrapper.find('[data-testid="agent-entry"]');
    expect(btn.exists()).toBe(true);
    await btn.trigger('click');
    await flushPromises();
    expect(wrapper.findComponent({ name: 'AgentChat' }).exists()).toBe(true);
  });

  it('品牌行右侧挂通知铃铛（V2.2a）：未读数经角标展示', async () => {
    notificationApi.unreadCount.mockResolvedValue(3);
    const wrapper = await mountLayout([]);
    await flushPromises();
    expect(wrapper.findComponent({ name: 'NotificationBell' }).exists()).toBe(true);
    expect(wrapper.text()).toContain('通知');
    expect(wrapper.find('.el-badge__content').text()).toBe('3');
  });

  it('首页菜单无权限点要求，登录即可见', async () => {
    const wrapper = await mountLayout([]);
    expect(wrapper.text()).toContain('首页');
  });

  it('有权限菜单可见：持 approval:view 可见审批中心', async () => {
    const wrapper = await mountLayout(['approval:view', 'approval:request']);
    expect(wrapper.text()).toContain('审批中心');
  });

  it('无权限菜单不渲染：无 approval:view 时审批中心不出现', async () => {
    // recorder 当前权限集（含 M06 案例素材提交点）：无 approval:view，审批中心不应渲染
    const wrapper = await mountLayout([
      'm06:view',
      'm06:edit',
      'm08:view',
      'm08:edit',
      'm12:view',
      'm12:edit',
    ]);
    expect(wrapper.text()).not.toContain('审批中心');
    expect(wrapper.text()).not.toContain('AI 通道管理');
    expect(wrapper.text()).toContain('首页');
  });

  it('AI 通道管理菜单：system:manage 或 ai:cost:view 任一命中可见（2026-08-13 成本可见性）', async () => {
    const withManage = await mountLayout(['system:manage']);
    expect(withManage.text()).toContain('AI 通道管理');
    const withCost = await mountLayout(['ai:cost:view']);
    expect(withCost.text()).toContain('AI 通道管理');
    const withoutPerm = await mountLayout(['approval:view']);
    expect(withoutPerm.text()).not.toContain('AI 通道管理');
  });

  it('降级横幅：globalEnabled=false 展示固定文案（P2-09）', async () => {
    fetchAiStatus.mockResolvedValue(makeStatus({ globalEnabled: false }));
    const wrapper = await mountLayout([]);
    expect(wrapper.text()).toContain('AI 暂不可用，请人工处理');
  });

  it('降级横幅：healthy=false 同样展示；正常态不渲染（P2-09）', async () => {
    fetchAiStatus.mockResolvedValue(makeStatus({ healthy: false }));
    const degraded = await mountLayout([]);
    expect(degraded.text()).toContain('AI 暂不可用，请人工处理');

    fetchAiStatus.mockResolvedValue(makeStatus());
    const normal = await mountLayout([]);
    expect(normal.text()).not.toContain('AI 暂不可用，请人工处理');
  });

  it('顶栏账号区（V2.6）：渲染当前用户名；确认弹窗后调用 store.logout 并回登录页', async () => {
    const wrapper = await mountLayout([]);
    expect(wrapper.find('.app-layout__username').text()).toBe('张店长');

    const logoutSpy = vi.spyOn(useAuthStore(layoutPinia!), 'logout');
    await wrapper.find('.app-layout__logout').trigger('click');
    await flushPromises();

    // ElMessageBox 渲染在 document.body：点确认按钮走真实弹窗链路
    const confirmBtn = document.querySelector<HTMLButtonElement>(
      '.el-message-box__btns .el-button--primary',
    );
    expect(confirmBtn).toBeTruthy();
    confirmBtn!.click();
    await flushPromises();

    expect(logoutSpy).toHaveBeenCalledTimes(1);
    expect(useAuthStore(layoutPinia!).user).toBeNull();
    expect(layoutRouter!.currentRoute.value.path).toBe('/login');
  });

  it('顶栏齿轮（#11）：打开改密对话框；确认≠新密前端拦截不发请求，改对后提交成功关框+成功提示', async () => {
    mockedChangePassword.mockResolvedValue({ ok: true });
    const messageSpy = vi.spyOn(ElMessage, 'success');
    const wrapper = await mountLayout([], true);

    // 齿轮入口唤起对话框
    await wrapper.find('[data-test="change-password-entry"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('修改密码');

    // 三项输入：确认密码故意填不一致 → 前端校验拦截，不发请求
    // （错误文案经 el-form refDebounced 100ms 才渲染，需真实等待而非仅 flushPromises）
    const inputs = wrapper.findAll('.el-dialog input');
    expect(inputs.length).toBe(3);
    await inputs[0].setValue('Old246802');
    await inputs[1].setValue('New246802');
    await inputs[2].setValue('Diff246802');
    const submitBtn = wrapper.findAll('button').find((b) => b.text() === '确认修改')!;
    await submitBtn.trigger('click');
    await new Promise((r) => setTimeout(r, 250));
    expect(wrapper.text()).toContain('两次输入的新密码不一致');
    expect(mockedChangePassword).not.toHaveBeenCalled();

    // 改对后提交：调 api 成功 → 关框（overlay display:none）+ 成功提示，登录态保持
    await inputs[2].setValue('New246802');
    await submitBtn.trigger('click');
    await flushPromises();
    expect(mockedChangePassword).toHaveBeenCalledWith('Old246802', 'New246802');
    expect(dialogOverlay(wrapper)?.attributes('style') ?? '').toContain('display: none');
    expect(messageSpy).toHaveBeenCalledWith('密码修改成功');
    expect(useAuthStore(layoutPinia!).user?.username).toBe('boss');
  });

  it('改密旧密错误（#11）：常驻错误提示且对话框保持打开，可重试', async () => {
    mockedChangePassword.mockRejectedValue({
      response: { status: 401, data: { code: 'AUTH_INVALID_CREDENTIALS', message: '原密码错误' } },
    });
    const wrapper = await mountLayout([], true);

    await wrapper.find('[data-test="change-password-entry"]').trigger('click');
    await flushPromises();
    const inputs = wrapper.findAll('.el-dialog input');
    await inputs[0].setValue('Wrong-Old1');
    await inputs[1].setValue('New246802');
    await inputs[2].setValue('New246802');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '确认修改')!
      .trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('原密码错误，请重试');
    // 对话框保持打开（overlay 未隐藏）
    expect(dialogOverlay(wrapper)?.attributes('style') ?? '').not.toContain('display: none');
  });
});
