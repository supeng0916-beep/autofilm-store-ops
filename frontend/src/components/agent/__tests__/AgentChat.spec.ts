import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AgentChat from '../AgentChat.vue';
import { agentApi } from '../../../api/agent';
import { assetApi } from '../../../api/asset';

// mock api：组件不发真实请求（AssetsUploadDialog.spec 模式）。
// chatStream mock 支持在 resolve 前触发 onDelta，验证流式增量上屏；
// assetApi mock 静音缩略/文件取流（blob 在 happy-dom 不可靠，走文字卡片降级路径）。
vi.mock('../../../api/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/agent')>();
  return { ...actual, agentApi: { chatStream: vi.fn() } };
});
vi.mock('../../../api/asset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/asset')>();
  return {
    ...actual,
    assetApi: { ...actual.assetApi, fetchThumb: vi.fn(), fetchFile: vi.fn() },
  };
});

// 部分 mock element-plus：ElMessage 静音（AssetsView.spec 模式）
const message = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('element-plus')>();
  return { ...actual, ElMessage: message };
});

const mockedStream = vi.mocked(agentApi.chatStream);
const mockedThumb = vi.mocked(assetApi.fetchThumb);

async function mountChat() {
  const wrapper = mount(AgentChat, {
    props: { modelValue: true },
    global: { plugins: [ElementPlus], stubs: { teleport: true } },
  });
  await flushPromises();
  return wrapper;
}

const send = async (wrapper: Awaited<ReturnType<typeof mountChat>>, text: string) => {
  await wrapper.find('[data-testid="agent-input"]').setValue(text);
  await wrapper.find('[data-testid="agent-send"]').trigger('click');
  await flushPromises();
};

describe('AgentChat 对话抽屉（2026-08-26 销售 Agent V1 + 流式迭代）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStream.mockImplementation(async (_msg, _history, handlers) => {
      handlers?.onDelta?.('您好，');
      handlers?.onDelta?.('小周为您服务');
      return { reply: '您好，小周为您服务', suggestions: ['复制话术'] };
    });
  });

  it('渲染输入与发送；空输入不发请求', async () => {
    const wrapper = await mountChat();
    expect(wrapper.find('[data-testid="agent-input"]').exists()).toBe(true);
    await wrapper.find('[data-testid="agent-send"]').trigger('click');
    await flushPromises();
    expect(mockedStream).not.toHaveBeenCalled();
  });

  it('发送：流式携带消息与历史 → 增量上屏后 done 终稿替换并渲染建议；二轮携带上轮历史', async () => {
    const wrapper = await mountChat();
    await send(wrapper, '给张三写条首触话术');

    expect(mockedStream).toHaveBeenCalledWith('给张三写条首触话术', [], expect.anything());
    expect(wrapper.text()).toContain('您好，小周为您服务');
    expect(wrapper.find('[data-testid="agent-suggestion"]').text()).toContain('复制话术');
    expect(wrapper.findAll('.agent-msg--user').length).toBe(1);
    expect(wrapper.findAll('.agent-msg--assistant').length).toBe(1);
    // 落定后不再显示流式光标
    expect(wrapper.find('.agent-msg__bubble--streaming').exists()).toBe(false);

    await send(wrapper, '再来条更口语的');
    expect(mockedStream).toHaveBeenLastCalledWith(
      '再来条更口语的',
      [
        { role: 'user', content: '给张三写条首触话术' },
        { role: 'assistant', content: '您好，小周为您服务' },
      ],
      expect.anything(),
    );
  });

  it('流式失败 → 离线提示气泡，输入保留可重试', async () => {
    mockedStream.mockRejectedValue(new Error('gateway down'));
    const wrapper = await mountChat();
    await send(wrapper, '写条催单话术');

    expect(wrapper.text()).toContain('AI 暂时离线，请稍后再试');
    expect((wrapper.find('[data-testid="agent-input"]').element as HTMLTextAreaElement).value).toBe(
      '写条催单话术',
    );
  });

  it('建议 chip 点击 → 内容填入输入框', async () => {
    const wrapper = await mountChat();
    await send(wrapper, '给李四写报价口径说明');
    await wrapper.find('[data-testid="agent-suggestion"]').trigger('click');
    expect((wrapper.find('[data-testid="agent-input"]').element as HTMLTextAreaElement).value).toBe(
      '复制话术',
    );
  });

  it('图片素材附件：done 携带 assets → 渲染附件卡片并按需取缩略；未授权带角标', async () => {
    mockedStream.mockResolvedValue({
      reply: '已找到素材，就在下方。',
      suggestions: [],
      assets: [
        { id: 'ast-1', title: '车衣报价图', licensed: true },
        { id: 'ast-2', title: '领克09完工案例', licensed: false },
      ],
    });
    const wrapper = await mountChat();
    await send(wrapper, '把车衣报价图发给我');

    const cards = wrapper.findAll('[data-testid="agent-asset"]');
    expect(cards.length).toBe(2);
    expect(cards[0].text()).toContain('车衣报价图');
    expect(cards[0].find('.agent-asset__unlicensed').exists()).toBe(false);
    expect(cards[1].text()).toContain('领克09完工案例');
    expect(cards[1].find('.agent-asset__unlicensed').exists()).toBe(true);
    expect(mockedThumb).toHaveBeenCalledWith('ast-1');
    expect(mockedThumb).toHaveBeenCalledWith('ast-2');
  });

  it('决策依据（T2 决策留痕）：done 携带 reasoning → 折叠入口默认收起，点开见正文；无 reasoning 不渲染', async () => {
    // 默认 mock（beforeEach）无 reasoning → 不渲染入口
    const plain = await mountChat();
    await send(plain, '写条早安朋友圈');
    expect(plain.find('[data-testid="agent-reasoning-toggle"]').exists()).toBe(false);

    // 带 reasoning → 入口在场且默认收起，点击展开
    mockedStream.mockResolvedValue({
      reply: '已按老客户复购场景写好催单话术。',
      suggestions: [],
      reasoning: '选催单方向因客户上月刚问过价；参考知识库报价口径；放弃首触话术。',
    });
    const wrapper = await mountChat();
    await send(wrapper, '给老客户写条催单话术');

    const toggle = wrapper.find('[data-testid="agent-reasoning-toggle"]');
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain('决策依据');
    expect(wrapper.find('[data-testid="agent-reasoning-body"]').exists()).toBe(false); // 默认收起
    await toggle.trigger('click');
    expect(wrapper.find('[data-testid="agent-reasoning-body"]').text()).toContain(
      '参考知识库报价口径',
    );
  });
});
