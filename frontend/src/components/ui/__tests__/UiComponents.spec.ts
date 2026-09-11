import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { describe, expect, it } from 'vitest';

import EmptyState from '../EmptyState.vue';
import FilterBar from '../FilterBar.vue';
import PageHeader from '../PageHeader.vue';
import StatCard from '../StatCard.vue';

// 换装共用组件四件（V2.5 Task1）：各 1 例渲染断言（props/slot 契约）。
describe('components/ui 换装共用组件', () => {
  it('PageHeader：渲染 title/sub 与 actions 槽', () => {
    const wrapper = mount(PageHeader, {
      props: { title: '审批中心', sub: '价格与内容变更的二次确认' },
      slots: { actions: '<button>发起审批</button>' },
    });
    expect(wrapper.find('.page-header__title').text()).toBe('审批中心');
    expect(wrapper.find('.page-header__sub').text()).toBe('价格与内容变更的二次确认');
    expect(wrapper.find('.page-header__actions').text()).toBe('发起审批');
  });

  it('StatCard：渲染 label/value，alert 时数字挂告警类', async () => {
    const normal = mount(StatCard, {
      props: { label: '今日新增客资', value: 6, tip: '按导入时间统计' },
    });
    expect(normal.find('.wg-num').text()).toBe('6');
    expect(normal.find('.wg-muted').text()).toBe('今日新增客资');
    expect(normal.find('.stat-card__tip').text()).toBe('按导入时间统计');
    expect(normal.find('.stat-card__num--alert').exists()).toBe(false);

    const alert = mount(StatCard, { props: { label: 'SLA 到期', value: 2, alert: true } });
    expect(alert.find('.stat-card__num--alert').exists()).toBe(true);
  });

  it('EmptyState：el-empty 描述与 image-size 60', () => {
    const wrapper = mount(EmptyState, {
      props: { desc: '暂无审批' },
      global: { plugins: [ElementPlus] },
    });
    expect(wrapper.find('.el-empty').exists()).toBe(true);
    expect(wrapper.find('.el-empty__description').text()).toBe('暂无审批');
    expect(wrapper.find('.el-empty__image').attributes('style')).toContain('60px');
  });

  it('FilterBar：横向槽容器渲染透传内容', () => {
    const wrapper = mount(FilterBar, {
      slots: { default: '<input placeholder="关键词" /><button>查询</button>' },
    });
    expect(wrapper.find('.filter-bar').exists()).toBe(true);
    expect(wrapper.find('input[placeholder="关键词"]').exists()).toBe(true);
    expect(wrapper.find('button').text()).toBe('查询');
  });
});
