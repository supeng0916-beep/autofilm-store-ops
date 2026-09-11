import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';

import { useAuthStore } from '../../stores/auth';
import SplashView from '../SplashView.vue';

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div>home</div>' } },
      { path: '/welcome', component: SplashView },
      { path: '/leads', component: { template: '<div>leads</div>' } },
    ],
  });
}

async function mountSplash(minMs = 100, redirect?: string) {
  const router = makeRouter();
  const pinia = createPinia();
  const auth = useAuthStore(pinia);
  auth.user = { id: 'u1', username: 'demo-sales-b', displayName: '销售乙' };
  const wrapper = mount(SplashView, {
    global: { plugins: [ElementPlus, pinia, router] },
    props: { minMs },
    attachTo: document.body,
  });
  await router.isReady();
  await router.push(redirect ? `/welcome?redirect=${redirect}` : '/welcome');
  await nextTick();
  return { wrapper, router };
}

describe('SplashView 登录过渡页（2026-08-21 品牌化）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('展示欢迎语（含用户名），未满最短时长不跳转', async () => {
    const { wrapper, router } = await mountSplash(2200);
    expect(wrapper.text()).toContain('销售乙，欢迎你！');
    expect(wrapper.text()).toContain('从这里开启和 AI 一起工作的时代');
    await vi.advanceTimersByTimeAsync(2199); // 未满 2.2s
    expect(router.currentRoute.value.path).toBe('/welcome');
    await vi.advanceTimersByTimeAsync(600); // 满 2.2s + 淡出 380ms
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/');
    wrapper.unmount();
  });

  it('尊重 minMs 需求下限：默认 2.2s ≥ 2s', async () => {
    // 不传 minMs，验证组件默认值满足「不小于 2 秒」的产品要求
    const router = makeRouter();
    const pinia = createPinia();
    const auth = useAuthStore(pinia);
    auth.user = { id: 'u1', username: 'demo-sales-b', displayName: '销售乙' };
    const wrapper = mount(SplashView, {
      global: { plugins: [ElementPlus, pinia, router] },
      attachTo: document.body,
    });
    await router.isReady();
    await nextTick();
    expect(wrapper.props('minMs')).toBeGreaterThanOrEqual(2000);
    wrapper.unmount();
  });

  it('携带 redirect 时跳转目标页', async () => {
    const { wrapper, router } = await mountSplash(100, '/leads');
    await vi.advanceTimersByTimeAsync(600);
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/leads');
    wrapper.unmount();
  });
});
