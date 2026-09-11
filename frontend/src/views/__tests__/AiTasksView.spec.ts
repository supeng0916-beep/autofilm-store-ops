import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchAiTaskDetail, fetchAiTasks, type AiTask, type AiTaskEvent } from '../../api/aiTasks';
import AiTasksView from '../AiTasksView.vue';

// mock api 模块（AssistantChat.spec 模式）：页面不发真实请求，列表/详情逐用例指定
vi.mock('../../api/aiTasks', () => ({
  fetchAiTasks: vi.fn(),
  fetchAiTaskDetail: vi.fn(),
  retryAiTask: vi.fn(),
  takeoverAiTask: vi.fn(),
}));

const mockedList = vi.mocked(fetchAiTasks);
const mockedDetail = vi.mocked(fetchAiTaskDetail);

function makeTask(overrides: Partial<AiTask> = {}): AiTask {
  return {
    id: 'task-1',
    taskType: 'lead.summary',
    refType: 'lead',
    refId: 'lead-1',
    status: 'degraded',
    inputSummary: '{"platform":"douyin","text":"贴膜多少钱"}',
    model: 'glm-4-flash',
    tokensIn: 320,
    tokensOut: 180,
    output: null,
    retryCount: 0,
    deadlineAt: null,
    dispatchedAt: null,
    callbackAt: null,
    finishedAt: null,
    errorMessage: '输出校验失败',
    costEstimateFen: 15,
    createdAt: '2026-08-19T02:00:00.000Z',
    updatedAt: '2026-08-19T02:00:05.000Z',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<AiTaskEvent> = {}): AiTaskEvent {
  return {
    id: 'evt-1',
    taskId: 'task-1',
    fromStatus: null,
    toStatus: 'pending',
    reason: null,
    createdAt: '2026-08-19T02:00:00.000Z',
    ...overrides,
  };
}

/** 行内指定文案的按钮集合（操作列按钮无 data-test，按文案定位） */
function buttonsOf(wrapper: Awaited<ReturnType<typeof mountView>>, text: string) {
  return wrapper.findAll('button').filter((b) => b.text().includes(text));
}

/** 挂载（抽屉 teleport 内联渲染，同 NotificationBell.spec 模式）；无 store 依赖。
 * ElSelect 在 happy-dom 下会陷入递归更新（element-plus options watcher 与 happy-dom 布局交互），
 * 本页三用例不覆盖筛选交互，stub 掉以隔离该环境级问题。 */
async function mountView() {
  const wrapper = mount(AiTasksView, {
    global: { plugins: [ElementPlus], stubs: { teleport: true, ElSelect: true } },
  });
  await flushPromises();
  return wrapper;
}

describe('AiTasksView Agent 任务控制台（V2.2b）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedList.mockResolvedValue([]);
    mockedDetail.mockResolvedValue({ task: makeTask(), events: [] });
  });

  it('渲染任务行与状态 tag：degraded 行为红色 danger tag 且文案为中文映射', async () => {
    mockedList.mockResolvedValue([makeTask(), makeTask({ id: 'task-2', status: 'done' })]);
    const wrapper = await mountView();

    expect(wrapper.text()).toContain('lead.summary');
    expect(wrapper.text()).toContain('贴膜多少钱');
    // degraded → danger + 「降级待人工」
    const dangerTag = wrapper.find('.el-tag--danger');
    expect(dangerTag.exists()).toBe(true);
    expect(dangerTag.text()).toContain('降级待人工');
    // done → success「成功」
    expect(wrapper.find('.el-tag--success').text()).toContain('成功');
  });

  it('重试按钮仅 failed/degraded 行显示：done 行不渲染', async () => {
    mockedList.mockResolvedValue([
      makeTask({ id: 'task-degraded', status: 'degraded' }),
      makeTask({ id: 'task-failed', status: 'failed' }),
      makeTask({ id: 'task-done', status: 'done' }),
    ]);
    const wrapper = await mountView();

    const retryButtons = buttonsOf(wrapper, '重试');
    expect(retryButtons).toHaveLength(2); // degraded + failed
    // done 行操作列只有详情/接管，无重试
    const doneRow = wrapper.findAll('tr').find((tr) => tr.text().includes('成功'));
    expect(doneRow?.text()).toContain('详情');
    expect(doneRow?.text()).toContain('接管');
    expect(doneRow?.findAll('button').filter((b) => b.text().includes('重试'))).toHaveLength(0);
  });

  it('点详情开抽屉：渲染输入摘要与事件时间线（fromStatus→toStatus+reason）', async () => {
    mockedList.mockResolvedValue([makeTask()]);
    mockedDetail.mockResolvedValue({
      task: makeTask(),
      events: [
        makeEvent({ id: 'evt-1', fromStatus: null, toStatus: 'pending' }),
        makeEvent({ id: 'evt-2', fromStatus: 'pending', toStatus: 'dispatched' }),
        makeEvent({
          id: 'evt-3',
          fromStatus: 'dispatched',
          toStatus: 'degraded',
          reason: 'manual_takeover',
        }),
      ],
    });
    const wrapper = await mountView();

    await buttonsOf(wrapper, '详情')[0]?.trigger('click');
    await flushPromises();

    expect(mockedDetail).toHaveBeenCalledWith('task-1');
    expect(wrapper.findComponent({ name: 'ElDrawer' }).props('modelValue')).toBe(true);
    // 输入摘要全文 + 错误红字
    expect(wrapper.text()).toContain('"platform":"douyin"');
    expect(wrapper.find('.ai-tasks__error').text()).toContain('输出校验失败');
    // 事件时间线：创建/排队 → 已派发 → 降级待人工（含 reason）
    expect(wrapper.findAll('.el-timeline-item')).toHaveLength(3);
    expect(wrapper.text()).toContain('创建 → 排队');
    expect(wrapper.text()).toContain('排队 → 已派发');
    expect(wrapper.text()).toContain('已派发 → 降级待人工');
    expect(wrapper.text()).toContain('manual_takeover');
  });

  it('决策依据（T2 决策留痕）：output 含 reasoning → 折叠项渲染；无 reasoning 不渲染', async () => {
    // 含 reasoning 的 done 任务
    mockedList.mockResolvedValue([makeTask({ status: 'done', output: null })]);
    mockedDetail.mockResolvedValue({
      task: makeTask({
        status: 'done',
        errorMessage: null,
        output: {
          reply: '已按老客户复购场景写好话术。',
          reasoning: '选催单方向因客户上月刚问过价；参考知识库报价口径；放弃首触话术。',
        },
      }),
      events: [],
    });
    const withReasoning = await mountView();
    await buttonsOf(withReasoning, '详情')[0]?.trigger('click');
    await flushPromises();
    // 折叠项标题在场（默认收起，点开见正文）
    const items = withReasoning.findAll('.el-collapse-item');
    expect(items.some((i) => i.text().includes('决策依据'))).toBe(true);
    await items
      .find((i) => i.text().includes('决策依据'))
      ?.find('.el-collapse-item__header')
      .trigger('click');
    await flushPromises();
    expect(withReasoning.find('[data-testid="ai-task-reasoning"]').text()).toContain(
      '参考知识库报价口径',
    );

    // 无 reasoning 的输出：折叠项不渲染
    mockedDetail.mockResolvedValue({
      task: makeTask({ status: 'done', errorMessage: null, output: { reply: '好的' } }),
      events: [],
    });
    const withoutReasoning = await mountView();
    await buttonsOf(withoutReasoning, '详情')[0]?.trigger('click');
    await flushPromises();
    expect(
      withoutReasoning.findAll('.el-collapse-item').some((i) => i.text().includes('决策依据')),
    ).toBe(false);
  });
});
