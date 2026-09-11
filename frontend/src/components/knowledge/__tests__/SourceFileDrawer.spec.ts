import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import { knowledgeApi } from '../../../api/knowledge';
import SourceFileDrawer from '../SourceFileDrawer.vue';

vi.mock('../../../api/knowledge', () => ({
  knowledgeApi: {
    sourceFile: vi.fn(),
  },
}));

const mockedSourceFile = vi.mocked(knowledgeApi.sourceFile);

function mountDrawer() {
  return mount(SourceFileDrawer, { global: { stubs: { teleport: true } } });
}

describe('SourceFileDrawer（知识源原始文件抽屉，#14）', () => {
  it('open() 拉取源文件并渲染 md 纯文本（pre）', async () => {
    mockedSourceFile.mockResolvedValue({
      path: '门店知识源/02-价格/门店报价.md',
      content: '# 门店报价\n\n| 方案 | 组合价 |\n|---|---|\n',
    });
    const wrapper = mountDrawer();
    await wrapper.vm.open('门店知识源/02-价格/门店报价.md');
    await flushPromises();
    expect(mockedSourceFile).toHaveBeenCalledWith('门店知识源/02-价格/门店报价.md');
    const pre = wrapper.find('pre.source-raw');
    expect(pre.exists()).toBe(true);
    expect(pre.text()).toContain('# 门店报价');
    expect(pre.text()).toContain('| 方案 | 组合价 |');
  });

  it('加载失败时显示空态且不崩溃', async () => {
    mockedSourceFile.mockRejectedValue(new Error('network'));
    const wrapper = mountDrawer();
    await wrapper.vm.open('门店知识源/99-不存在.md');
    await flushPromises();
    expect(wrapper.find('pre.source-raw').exists()).toBe(false);
    expect(wrapper.text()).toContain('文件内容为空或加载失败');
  });
});
