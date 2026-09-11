import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus, { ElSelect } from 'element-plus';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { KnowledgeItem } from '../../api/knowledge';
import KnowledgeManageView from '../KnowledgeManageView.vue';

// mock api 模块：列表数据可控，其余方法空实现
const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  activate: vi.fn(),
  expire: vi.fn(),
  versions: vi.fn(),
}));
vi.mock('../../api/knowledge', () => ({ knowledgeApi: api }));

function makeItem(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id: 'k-' + Math.random().toString(36).slice(2, 8),
    kind: 'price',
    key: 'price-x',
    title: '条目',
    content: '内容',
    version: 1,
    source: null,
    licensed: true,
    expiresAt: null,
    status: 'active',
    tags: null,
    createdBy: 'u1',
    approvedBy: null,
    approvedAt: null,
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  };
}

/** 类别下拉 = 第一个 ElSelect（品牌筛选为按钮而非下拉，不影响定位） */
async function selectKind(wrapper: ReturnType<typeof mount>, kind: string) {
  const kindSelect = wrapper.findAllComponents(ElSelect)[0];
  await kindSelect.setValue(kind);
  await kindSelect.vm.$emit('change', kind);
  await flushPromises();
}

describe('KnowledgeManageView 品牌筛选（2026-08-21 门店反馈）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('未选类别时不出现品牌 chips；选中后按品牌过滤列表', async () => {
    api.list.mockResolvedValue([
      makeItem({ id: 'k-wg', title: '演示品牌 DM03 标准报价' }),
      makeItem({ id: 'k-lk', title: '演示品牌乙 D75 标准报价' }),
      makeItem({ id: 'k-ty', title: '双膜套餐一口价' }),
    ]);
    const wrapper = mount(KnowledgeManageView, { global: { plugins: [ElementPlus] } });
    await flushPromises();

    // 未选类别：无品牌 chips，三行全展示
    expect(wrapper.find('[data-test="brand-chips"]').exists()).toBe(false);
    expect(wrapper.findAll('.el-table__row')).toHaveLength(3);

    // 选中类别（价格）：chips 出现，含计数
    await selectKind(wrapper, 'price');
    expect(wrapper.find('[data-test="brand-chips"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="brand-chip-演示品牌"]').text()).toContain('演示品牌 1');
    expect(wrapper.find('[data-test="brand-chip-演示品牌乙"]').text()).toContain('演示品牌乙 1');
    expect(wrapper.find('[data-test="brand-chip-通用"]').text()).toContain('通用 1');

    // 点击演示品牌乙：只展示演示品牌乙条目
    await wrapper.find('[data-test="brand-chip-演示品牌乙"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.el-table__row')).toHaveLength(1);
    expect(wrapper.find('.el-table__row').text()).toContain('演示品牌乙 D75');

    // 「全部品牌」恢复
    await wrapper.find('[data-test="brand-chip-all"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.el-table__row')).toHaveLength(3);
  });

  it('切换类别时品牌筛选复位', async () => {
    api.list.mockResolvedValue([makeItem({ title: '演示品牌乙 D75 标准报价' })]);
    const wrapper = mount(KnowledgeManageView, { global: { plugins: [ElementPlus] } });
    await flushPromises();

    await selectKind(wrapper, 'price');
    await wrapper.find('[data-test="brand-chip-演示品牌乙"]').trigger('click');
    await selectKind(wrapper, 'product'); // 换类别：复位
    const active = wrapper.findAll('.knowledge-manage__brand-chip.is-active');
    expect(active).toHaveLength(1);
    expect(active[0].text()).toContain('全部品牌');
  });
});
