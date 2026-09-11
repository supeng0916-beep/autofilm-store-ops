import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  overview,
  updateTechnician,
  type AgentRow,
  type StaffRecordRow,
  type TeamOverview,
  type TechnicianCard,
} from '../../api/team';
import TeamView from '../TeamView.vue';

// 权限 composable 整体 mock（Task 3 口径）：can 行为经 canMock 逐用例指定，
// 写按钮显隐走 can('approval:decide')（后端写守卫为 boss|store_manager 角色硬校验）
const { canMock } = vi.hoisted(() => ({ canMock: vi.fn<(perm: string) => boolean>() }));

vi.mock('../../composables/usePermission', () => ({
  usePermission: () => ({ can: canMock }),
}));

// mock api 模块（AssetsView.spec importOriginal 模式）：常量（KIND_LABEL/TAG）保留原实现，
// 仅替四个端点函数面——页面不发真实请求，数据逐用例指定
vi.mock('../../api/team', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/team')>();
  return {
    ...actual,
    overview: vi.fn(),
    createTechnician: vi.fn(),
    updateTechnician: vi.fn(),
    createRecord: vi.fn(),
  };
});

const mockedOverview = vi.mocked(overview);
const mockedUpdate = vi.mocked(updateTechnician);

function makeTechnician(overrides: Partial<TechnicianCard> = {}): TechnicianCard {
  return {
    id: 't1',
    kind: 'technician',
    name: '技师甲',
    skills: [],
    active: true,
    currentWorkOrder: null,
    stats: { total: 0, delivered: 0, rework: 0, revenueFen: 0 },
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    taskType: 'lead.summary',
    skillName: '客资摘要',
    kind: 'agent',
    ...overrides,
    // recent30d 单独浅合并（overrides 顶层展开会整块覆盖）
    recent30d: { total: 0, doneRate: 0, avgSeconds: null, lastRunAt: null, ...overrides.recent30d },
  };
}

function makeRecord(overrides: Partial<StaffRecordRow> = {}): StaffRecordRow {
  return {
    id: 'r1',
    subjectType: 'technician',
    subjectId: 't1',
    subjectName: '技师甲',
    kind: 'reward',
    content: '客户点名表扬',
    occurredAt: '2026-08-19T01:00:00.000Z',
    recordedBy: 'u1',
    recorderName: '店长',
    createdAt: '2026-08-19T01:05:00.000Z',
    ...overrides,
  };
}

/** 挂载（ElSelect 在 happy-dom 下会递归更新，沿 AiTasksView.spec stub 先例；
 * 录入对话框未打开不触 ElDatePicker，一并 stub 隔离环境级问题） */
async function mountView(ov: TeamOverview, canDecide = true) {
  mockedOverview.mockResolvedValue(ov);
  canMock.mockImplementation((perm: string) => perm === 'approval:decide' && canDecide);
  const wrapper = mount(TeamView, {
    global: {
      plugins: [ElementPlus],
      stubs: { teleport: true, ElSelect: true, ElDatePicker: true },
    },
  });
  await flushPromises();
  return wrapper;
}

describe('TeamView 人机团队（V2.4）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('技师卡渲染：施工中单号/空闲绿点、四指标、技能 tags、停用灰标与雷达图例', async () => {
    const wrapper = await mountView({
      technicians: [
        makeTechnician({
          id: 't1',
          name: '技师甲',
          skills: ['color_change', 'window_film'],
          currentWorkOrder: { orderNo: 'W-2608-002', stage: 'in_progress' },
          stats: { total: 10, delivered: 8, rework: 1, revenueFen: 1234500 },
        }),
        makeTechnician({ id: 't2', name: '师傅A', active: false }),
        // 回归（2026-08-28 忙闲修复）：待入场单也显示有活及真实阶段
        makeTechnician({
          id: 't3',
          name: '技师乙',
          currentWorkOrder: { orderNo: 'W-2608-007', stage: 'pending' },
        }),
      ],
      agents: [],
      records: [makeRecord({ kind: 'punish', subjectName: '师傅A', content: '迟到 30 分钟' })],
    });

    // 忙闲：施工中带单号，待入场显示真实阶段，无单才空闲
    expect(wrapper.text()).toContain('🛠 施工中 W-2608-002');
    expect(wrapper.text()).toContain('🛠 待入场 W-2608-007');
    expect(wrapper.text()).toContain('空闲');
    // 四指标：第一张卡 stats 块依次 施工/交付/返工/产值（fen→¥，千分位）
    const stats = wrapper.findAll('.tech-card__stat b').map((b) => b.text());
    expect(stats.slice(0, 4)).toEqual(['10', '8', '1', '¥12,345']);
    // 技能 tags（V1.5：枚举数组经 LABEL 映射中文）与停用灰标
    expect(wrapper.text()).toContain('改色膜');
    expect(wrapper.text()).toContain('窗膜');
    expect(wrapper.find('.el-tag--info').text()).toContain('停用');
    // 雷达：值域多边形（clip-path）与图例小字；组内唯一有数技师全维归一=1
    const valueShapes = wrapper.findAll('.tech-card__radar-value');
    expect(valueShapes).toHaveLength(3);
    expect(valueShapes[0]?.attributes('style')).toContain('polygon(');
    expect(wrapper.text()).toContain('施工量 · 交付率 · 低返工 · 产值 · 活跃');
    // 下区记录：惩红 tag + 对象 + 内容
    expect(wrapper.find('.el-tag--danger').text()).toContain('处罚');
    expect(wrapper.text()).toContain('迟到 30 分钟');
    // 写权限持有人：新增技师入口在
    expect(wrapper.findAll('button').some((b) => b.text().includes('新增技师'))).toBe(true);
  });

  it('Agent 行：AI 蓝徽标、技能/taskType、近30天任务数、完成率与均耗时分秒格式', async () => {
    const wrapper = await mountView({
      technicians: [],
      agents: [
        makeAgent({
          recent30d: {
            total: 5,
            doneRate: 0.8,
            avgSeconds: 95,
            lastRunAt: '2026-08-19T02:00:00.000Z',
          },
        }),
        makeAgent({ taskType: 'hello', skillName: '通道自检' }),
      ],
      records: [],
    });

    // 每行一个 AI 徽标
    const badges = wrapper.findAll('.team__ai-badge');
    expect(badges).toHaveLength(2);
    expect(badges[0]?.text()).toBe('AI');
    expect(wrapper.text()).toContain('客资摘要');
    expect(wrapper.text()).toContain('lead.summary');
    // 完成率 0.8→80%；均耗时 95s→1分35秒；任务数 5
    expect(wrapper.text()).toContain('80%');
    expect(wrapper.text()).toContain('1分35秒');
    expect(wrapper.text()).toContain('5');
    // 无样本行（total 0）：均耗时/最近运行为 '-'，完成率 0%
    const idleRow = wrapper.findAll('tr').find((tr) => tr.text().includes('hello'));
    expect(idleRow?.text()).toContain('0%');
    expect(idleRow?.text()).toContain('-');
  });

  it('无 approval:decide：新增技师/录入记录/改名/技能/批量改名按钮均不渲染', async () => {
    const wrapper = await mountView(
      { technicians: [makeTechnician()], agents: [], records: [] },
      false,
    );

    const buttons = wrapper.findAll('button').map((b) => b.text());
    expect(buttons.some((t) => t.includes('新增技师'))).toBe(false);
    expect(buttons.some((t) => t.includes('录入记录'))).toBe(false);
    expect(buttons.some((t) => t.includes('改名'))).toBe(false);
    expect(buttons.some((t) => t.includes('技能'))).toBe(false);
    expect(buttons.some((t) => t.includes('批量改名'))).toBe(false);
    // 查看面不受影响：刷新仍在，技师卡正常渲染
    expect(buttons.some((t) => t.includes('刷新'))).toBe(true);
    expect(wrapper.text()).toContain('技师甲');
  });

  it('技能编辑：卡片"技能"按钮打开对话框，保存按枚举数组提交 updateTechnician', async () => {
    mockedUpdate.mockResolvedValue({});
    const wrapper = await mountView({
      technicians: [makeTechnician({ skills: ['window_film'] })],
      agents: [],
      records: [],
    });

    const skillBtn = wrapper.findAll('button').find((b) => b.text().includes('技能'));
    expect(skillBtn).toBeTruthy();
    await skillBtn?.trigger('click');
    await flushPromises();
    // 对话框标题带技师名；保存按当前 skills 数组提交并刷新
    expect(wrapper.find('.el-dialog__title')?.text()).toContain('技能编辑：技师甲');
    const saveBtn = wrapper.findAll('.el-dialog button').find((b) => b.text().includes('保存'));
    await saveBtn?.trigger('click');
    await flushPromises();
    expect(mockedUpdate).toHaveBeenCalledWith('t1', { skills: ['window_film'] });
    // 保存后列表重载（挂载 1 次 + 保存后 1 次）
    expect(mockedOverview).toHaveBeenCalledTimes(2);
  });

  it('批量改名：逐条 PATCH 改动行，allSettled 汇报成败数；未改动行跳过', async () => {
    mockedUpdate.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('conflict'));
    const wrapper = await mountView({
      technicians: [
        makeTechnician({ id: 't1', name: '技师甲' }),
        makeTechnician({ id: 't2', name: '师傅A' }),
        makeTechnician({ id: 't3', name: '师傅B' }),
      ],
      agents: [],
      records: [],
    });

    const batchBtn = wrapper.findAll('button').find((b) => b.text().includes('批量改名'));
    expect(batchBtn).toBeTruthy();
    await batchBtn?.trigger('click');
    await flushPromises();
    // 每行一个输入框（旧名 → 新名）
    const inputs = wrapper.findAll('.team__rename-row input');
    expect(inputs).toHaveLength(3);
    await inputs[0]?.setValue('黄一新');
    await inputs[1]?.setValue('师傅甲');
    // t3 保持原名 → 跳过不发请求
    const submitBtn = wrapper.findAll('.el-dialog button').find((b) => b.text().includes('提交'));
    await submitBtn?.trigger('click');
    await flushPromises();
    expect(mockedUpdate).toHaveBeenCalledTimes(2);
    expect(mockedUpdate).toHaveBeenNthCalledWith(1, 't1', { name: '黄一新' });
    expect(mockedUpdate).toHaveBeenNthCalledWith(2, 't2', { name: '师傅甲' });
    // 1 成 1 败：warning 汇报成败数（ElMessage 挂载 body）
    expect(document.body.textContent).toContain('成功 1 条，失败 1 条');
  });
});
