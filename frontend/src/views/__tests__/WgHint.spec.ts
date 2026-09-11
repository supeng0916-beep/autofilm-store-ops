import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { describe, expect, it } from 'vitest';

import WgHint from '../../components/ui/WgHint.vue';
import WgHintIcon from '../../components/ui/WgHintIcon.vue';

/** 提示卡片组件（2026-08-26 老板需求）：注册表有 key → 渲染提示；缺 key → 透传/不渲染（不阻塞功能）。 */
describe('WgHint / WgHintIcon 提示组件', () => {
  it('WgHint：key 存在时包裹 el-tooltip 且透传按钮', () => {
    const wrapper = mount(
      {
        components: { WgHint },
        template: '<WgHint k="lead.copyDraft"><button>一键复制</button></WgHint>',
      },
      { global: { plugins: [ElementPlus] } },
    );
    expect(wrapper.findComponent({ name: 'ElTooltip' }).exists()).toBe(true);
    expect(wrapper.text()).toContain('一键复制');
  });

  it('WgHint：key 缺失时不渲染 tooltip，仅透传内容（文案未补齐不阻塞功能）', () => {
    const wrapper = mount(
      {
        components: { WgHint },
        template: '<WgHint k="nonexistent.key"><button>按钮</button></WgHint>',
      },
      { global: { plugins: [ElementPlus] } },
    );
    expect(wrapper.findComponent({ name: 'ElTooltip' }).exists()).toBe(false);
    expect(wrapper.text()).toContain('按钮');
  });

  it('WgHintIcon：key 存在时渲染「?」触发器；缺失时整个图标不渲染', () => {
    const withKey = mount(WgHintIcon, {
      props: { k: 'queue.card' },
      global: { plugins: [ElementPlus] },
    });
    expect(withKey.find('[data-testid="wg-hint-icon"]').exists()).toBe(true);

    const noKey = mount(WgHintIcon, {
      props: { k: 'nonexistent.key' },
      global: { plugins: [ElementPlus] },
    });
    expect(noKey.find('[data-testid="wg-hint-icon"]').exists()).toBe(false);
  });
});
