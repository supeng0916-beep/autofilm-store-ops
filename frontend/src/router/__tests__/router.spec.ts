import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';
import { RouterView } from 'vue-router';

import { fetchMe } from '../../api/auth';
import { useAuthStore } from '../../stores/auth';
import router from '../index';

// 水合测试不发真实请求：整模块 mock，fetchMe 行为逐用例指定
vi.mock('../../api/auth', () => ({
  login: vi.fn(),
  fetchMe: vi.fn(),
}));

// ai-settings 懒加载会连带 AppLayout 轮询与页面请求：mock ai api，避免真实网络。
// 影子面板三请求（fetchShadowIntent/Draft/SkillVersions，2026-09-02 阶段三）在
// isBoss 命中的用例会真实发起，缺 mock 会成 unhandled rejection 拖红整个门禁。
vi.mock('../../api/ai', () => ({
  fetchAiStatus: vi.fn(async () => ({
    globalEnabled: true,
    healthy: true,
    lastHealthyAt: null,
    lastError: null,
    skills: [],
    notice: null,
  })),
  fetchAiSwitches: vi.fn(async () => ({ global: true, skills: [] })),
  setAiSwitch: vi.fn(),
  fetchAiDailyCosts: vi.fn(async () => []),
  fetchShadowIntent: vi.fn(async () => ({
    days: 30,
    total: 0,
    agreed: 0,
    agreementRate: 1,
    overrides: [],
    overrideSamples: [],
  })),
  fetchShadowDraft: vi.fn(async () => ({
    days: 30,
    total: 0,
    avgSimilarity: 1,
    verbatimRate: 1,
    samples: [],
    verbatimCandidates: [],
  })),
  fetchSkillVersions: vi.fn(async () => []),
}));

const App = defineComponent({ render: () => h(RouterView) });

// router.resolve 不触发全局守卫（守卫仅在导航时执行），无需注入 token。
describe('路由解析', () => {
  it('未匹配路由解析到 not-found 兜底', () => {
    expect(router.resolve('/no-such-page').name).toBe('not-found');
  });

  it('多层未匹配路径同样落到 not-found', () => {
    expect(router.resolve('/a/b/c').name).toBe('not-found');
  });

  it('/login 正常解析', () => {
    expect(router.resolve('/login').name).toBe('login');
  });

  it('/ 正常解析到首页', () => {
    expect(router.resolve('/').name).toBe('home');
  });

  it('已注册的子路由不受兜底影响', () => {
    expect(router.resolve('/approvals').name).toBe('approvals');
  });

  it('/ai-settings 正常解析且 meta 声明权限点数组（P2-09 / 2026-08-13 成本可见性）', () => {
    const resolved = router.resolve('/ai-settings');
    expect(resolved.name).toBe('ai-settings');
    expect(resolved.meta.permission).toEqual(['system:manage', 'ai:cost:view']);
  });
});

describe('ai-settings 页面权限门禁（数组 permission：任一命中放行，全无拒绝）', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(fetchMe).mockReset();
  });

  /** 注入 token + 指定权限点水合后导航到 /ai-settings，返回最终路由名 */
  async function navigateAs(permissions: string[]): Promise<string> {
    localStorage.setItem('wg.accessToken', 'fake-access-token');
    vi.mocked(fetchMe).mockResolvedValueOnce({
      user: { id: 'u1', username: 'alice', displayName: '爱丽丝' },
      roles: ['boss'],
      permissions,
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(App, { global: { plugins: [ElementPlus, pinia, router] } });
    await router.isReady();
    await router.push('/ai-settings');
    await flushPromises();
    const name = String(router.currentRoute.value.name);
    wrapper.unmount();
    return name;
  }

  it('数组权限点全无命中：访问 /ai-settings 被拦回首页', async () => {
    expect(await navigateAs(['approval:view'])).toBe('home');
  });

  it('数组权限点任一命中（system:manage）可进入 /ai-settings', async () => {
    expect(await navigateAs(['system:manage'])).toBe('ai-settings');
  });

  it('数组权限点任一命中（ai:cost:view，boss 场景）可进入 /ai-settings', async () => {
    expect(await navigateAs(['ai:cost:view'])).toBe('ai-settings');
  });
});

describe('会话水合（刷新后 token 在、user/权限态丢失的恢复）', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(fetchMe).mockReset();
  });

  it('有 token 而 user 未加载时，进入受保护路由自动水合权限', async () => {
    localStorage.setItem('wg.accessToken', 'fake-access-token');
    vi.mocked(fetchMe).mockResolvedValueOnce({
      user: { id: 'u1', username: 'alice', displayName: '爱丽丝' },
      roles: ['boss'],
      permissions: ['approval:view'],
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    // pinia 先于 router 安装，保证守卫内 useAuthStore() 有活跃 pinia
    const wrapper = mount(App, { global: { plugins: [ElementPlus, pinia, router] } });
    await router.isReady();
    await flushPromises();

    const auth = useAuthStore(pinia);
    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(auth.user?.id).toBe('u1');
    expect(auth.permissions).toEqual(['approval:view']);
    expect(router.currentRoute.value.name).toBe('home');
    // 水合完成后，依赖权限点的菜单恢复可见
    expect(wrapper.text()).toContain('审批中心');
    wrapper.unmount();
  });

  it('水合失败（令牌失效/账号异常）清登录态并回登录页', async () => {
    localStorage.setItem('wg.accessToken', 'stale-token');
    vi.mocked(fetchMe).mockRejectedValueOnce(new Error('401'));
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(App, { global: { plugins: [ElementPlus, pinia, router] } });
    await router.push('/approvals');
    await flushPromises();

    const auth = useAuthStore(pinia);
    expect(auth.isLoggedIn).toBe(false);
    expect(auth.user).toBeNull();
    expect(localStorage.getItem('wg.accessToken')).toBeNull();
    expect(router.currentRoute.value.name).toBe('login');
    expect(router.currentRoute.value.query.redirect).toBe('/approvals');
    wrapper.unmount();
  });
});
