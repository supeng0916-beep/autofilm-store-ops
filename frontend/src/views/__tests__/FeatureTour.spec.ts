import { flushPromises, mount } from '@vue/test-utils';
/* global localStorage */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import FeatureTour from '../../components/layout/FeatureTour.vue';

/** 引导目标元素：注册到 body 上模拟真实界面（AppLayout 顶栏按钮等） */
function plantTarget(selector: string, x: number, y: number, w = 120, h = 36): void {
  const el = document.createElement('div');
  el.className = selector.replace(/^\./, '').replace(/\[data-test="(.+?)"\]/, '');
  if (selector.startsWith('[data-test')) {
    el.setAttribute('data-test', selector.match(/"(.+?)"/)![1]);
  }
  // jsdom 无布局：直接伪造 getBoundingClientRect
  el.getBoundingClientRect = () =>
    ({
      x,
      y,
      width: w,
      height: h,
      top: y,
      left: x,
      right: x + w,
      bottom: y + h,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.appendChild(el);
}

async function openTour() {
  const wrapper = mount(FeatureTour, { props: { visible: true }, attachTo: document.body });
  await nextTick();
  await flushPromises();
  return wrapper;
}

describe('FeatureTour 功能引导（教练标注式，2026-08-22）', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    plantTarget('.global-search', 24, 80, 180, 34);
    plantTarget('[data-test="notification-bell"]', 300, 60, 60, 34);
    plantTarget('[data-test="theme-toggle"]', 900, 60, 40, 32);
    plantTarget('[data-test="change-password-entry"]', 960, 60, 40, 32);
    plantTarget('[data-test="tips-entry"]', 1020, 60, 40, 32);
    plantTarget('.app-layout__aside', 0, 0, 200, 600);
  });
  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('打开后出现聚焦挖孔与指向卡（第 1 步：全店搜索）', async () => {
    const w = await openTour();
    expect(w.find('[data-test="feature-tour"]').exists()).toBe(true);
    expect(w.text()).toContain('全店搜索');
    // 聚焦框位置对准目标（x-6 缓冲）
    const spot = w.find('.tour__spot');
    expect(spot.attributes('style')).toContain(`left: ${24 - 6}px`);
    // 卡片箭头类存在
    expect(w.find('.tour__card').classes()).toContain('tour__card--right');
    w.unmount();
  });

  it('下一步推进、走完标记完成并收起', async () => {
    const w = await openTour();
    const next = w.find('[data-test="tour-next"]');
    expect(w.text()).toContain('1/6');
    await next.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('2/6');
    expect(w.text()).toContain('通知铃铛');
    // 连点到最后一步并完成
    for (let i = 0; i < 4; i += 1) {
      await next.trigger('click');
      await flushPromises();
    }
    expect(w.text()).toContain('开始使用');
    await next.trigger('click');
    expect(localStorage.getItem('wg.tipsDone')).toBe('1');
    expect(w.emitted('update:visible')?.at(-1)).toEqual([false]);
    w.unmount();
  });

  it('2026-08-28 UI 测试 #7：弹窗打开时挂起不遮挡，弹窗关闭后自动出现', async () => {
    // 模拟 el-dialog 遮罩挂在 body（预约表单填到一半的场景）
    const overlay = document.createElement('div');
    overlay.className = 'el-overlay';
    document.body.appendChild(overlay);
    vi.useFakeTimers();
    let wrapper: ReturnType<typeof mount>;
    try {
      wrapper = mount(FeatureTour, { props: { visible: true }, attachTo: document.body });
      await nextTick();
      await flushPromises();
      // 遮罩在场：tour 不出现（此前 z-2500 悬浮最上层会遮挡表单点击全部失效）
      expect(wrapper.find('[data-test="feature-tour"]').exists()).toBe(false);

      overlay.remove();
      vi.advanceTimersByTime(350); // 轮询间隔 300ms
      await flushPromises();
      expect(wrapper.find('[data-test="feature-tour"]').exists()).toBe(true);
      expect(wrapper.text()).toContain('全店搜索');
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('「跳过」同样标记完成并收起；目标缺失的步骤自动跳过', async () => {
    document.body.innerHTML = '';
    // 只种第 1、3 步的目标（第 2 步铃铛缺失）
    plantTarget('.global-search', 24, 80, 180, 34);
    plantTarget('[data-test="theme-toggle"]', 900, 60, 40, 32);
    const w = await openTour();
    const next = w.find('[data-test="tour-next"]');
    await next.trigger('click'); // 1→2（铃铛缺失自动跳到 3）
    await flushPromises();
    expect(w.text()).toContain('深色 / 浅色模式');
    const skip = w.findAll('.tour__ghost').filter((b) => b.text() === '跳过')[0];
    await skip!.trigger('click'); // 跳过（排除「上一步」）
    expect(localStorage.getItem('wg.tipsDone')).toBe('1');
    expect(w.emitted('update:visible')?.at(-1)).toEqual([false]);
    w.unmount();
  });
});
