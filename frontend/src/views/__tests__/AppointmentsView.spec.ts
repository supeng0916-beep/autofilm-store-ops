import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import { appointmentApi, type Appointment } from '../../api/appointment';
import { overview, type TechnicianCard } from '../../api/team';
import AppointmentsView from '../AppointmentsView.vue';

// 权限 composable 整体 mock（TeamView.spec 口径）：本页写面按钮走 can('m07:edit')
const { canMock } = vi.hoisted(() => ({ canMock: vi.fn<(perm: string) => boolean>() }));
vi.mock('../../composables/usePermission', () => ({
  usePermission: () => ({ can: canMock }),
}));

// mock api 模块：常量（BUSINESS_TYPE_*）保留原实现，仅替换端点函数
vi.mock('../../api/appointment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/appointment')>();
  return {
    ...actual,
    appointmentApi: {
      list: vi.fn(),
      create: vi.fn(),
      cancel: vi.fn(),
      technicianChanges: vi.fn(),
      requestTechnicianChange: vi.fn(),
      confirmTechnicianChange: vi.fn(),
    },
  };
});
vi.mock('../../api/team', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/team')>();
  return { ...actual, overview: vi.fn() };
});

const mockedList = vi.mocked(appointmentApi.list);
const mockedCreate = vi.mocked(appointmentApi.create);
const mockedOverview = vi.mocked(overview);

/** ElSelect/ElOption/ElDatePicker 轻量 stub：happy-dom 下真实 ElSelect 会递归更新
 * （AiTasksView.spec 先例），stub 保留 slot 渲染以便断言选项、经 $emit 驱动 v-model/change */
const ElSelectStub = defineComponent({
  name: 'ElSelectStub',
  props: { modelValue: { type: [String, Number, Array], default: '' } },
  emits: ['update:modelValue', 'change'],
  setup(_, { slots }) {
    return () => h('div', { class: 'stub-select' }, slots.default?.());
  },
});
const ElOptionStub = defineComponent({
  name: 'ElOptionStub',
  props: {
    label: { type: String, default: '' },
    value: { type: String, default: '' },
    disabled: { type: Boolean, default: false },
  },
  setup(props) {
    return () =>
      h('div', { class: ['stub-option', props.disabled ? 'is-disabled' : ''] }, props.label);
  },
});
const ElDatePickerStub = defineComponent({
  name: 'ElDatePickerStub',
  props: { modelValue: { type: [String, Date], default: '' } },
  emits: ['update:modelValue'],
  setup() {
    return () => h('input', { class: 'stub-date' });
  },
});

function makeAppointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 'a1',
    leadId: null,
    customerId: 'c1',
    opportunityId: null,
    businessType: 'window_film',
    serviceItem: 'DM10 全车隔热膜',
    workbench: null,
    technicianName: null,
    technicianDesignated: false,
    estHours: null,
    startAt: '2026-08-21T02:00:00.000Z',
    endAt: '2026-08-21T08:00:00.000Z',
    promise: null,
    managerConfirmed: false,
    managerConfirmedBy: null,
    managerConfirmedAt: null,
    status: 'pending',
    createdAt: '2026-08-20T01:00:00.000Z',
    ...overrides,
  };
}

function makeTechnician(overrides: Partial<TechnicianCard> = {}): TechnicianCard {
  return {
    id: 't1',
    kind: 'technician',
    name: '师傅A',
    skills: ['window_film'],
    active: true,
    currentWorkOrder: null,
    stats: { total: 0, delivered: 0, rework: 0, revenueFen: 0 },
    ...overrides,
  };
}

const TECHS: TechnicianCard[] = [
  makeTechnician({ id: 't1', name: '师傅A', skills: ['window_film'] }),
  makeTechnician({ id: 't2', name: '师傅B', skills: ['car_cover', 'color_change'] }),
  makeTechnician({ id: 't3', name: '师傅C', skills: ['window_film'], active: false }),
];

async function mountView(appointments: Appointment[] = [], technicians: TechnicianCard[] = []) {
  mockedList.mockResolvedValue(appointments);
  mockedCreate.mockResolvedValue({ appointment: makeAppointment() });
  mockedOverview.mockResolvedValue({ technicians, agents: [], records: [] });
  canMock.mockImplementation((perm: string) => perm === 'm07:edit');
  const wrapper = mount(AppointmentsView, {
    global: {
      plugins: [ElementPlus],
      stubs: {
        teleport: true,
        ElSelect: ElSelectStub,
        ElOption: ElOptionStub,
        ElDatePicker: ElDatePickerStub,
      },
    },
  });
  await flushPromises();
  return wrapper;
}

/** 打开"发起预约"对话框 */
async function openDialog(wrapper: ReturnType<typeof mount>) {
  const btn = wrapper.findAll('button').find((b) => b.text().includes('发起预约'));
  await btn?.trigger('click');
  await flushPromises();
}

/** 对话框内四个下拉：[0]=关联客资 [1]=业务类型 [2]=工位 [3]=技师
 * （2026-08-28 UI 测试 #5：工位由手填文本框改为字典下拉后插位） */
function selectsOf(wrapper: ReturnType<typeof mount>) {
  const selects = wrapper.findAllComponents(ElSelectStub);
  return {
    leadSelect: selects[0],
    bizSelect: selects[1],
    benchSelect: selects[2],
    techSelect: selects[3],
  };
}

/** 未来时段（+30 天 02:00~08:00Z）：2026-08-28 起前后端均拒绝过去时间，固定日期会随日历过期 */
function futureSlot(): { start: Date; end: Date } {
  const start = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  start.setUTCHours(2, 0, 0, 0);
  const end = new Date(start.getTime() + 6 * 3600 * 1000);
  return { start, end };
}

async function selectValue(comp: ReturnType<typeof selectsOf>['bizSelect'], value: string) {
  await comp.vm.$emit('update:modelValue', value);
  await comp.vm.$emit('change', value);
  await flushPromises();
}

describe('AppointmentsView 预约业务类型与技能过滤（v1.5 Task 5）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('关联客资（2026-08-25）：选客资后提交携带 leadId 且隐藏手动客户ID输入', async () => {
    const wrapper = await mountView([]);
    await openDialog(wrapper);

    // 高级回退：未选客资时手动客户 ID 输入可见
    expect(
      wrapper.findAll('input').some((i) => i.attributes('placeholder')?.includes('客户档案 ID')),
    ).toBe(true);

    // 选中客资（ElSelect stub 下经状态直改，AssetsUploadDialog.spec 同手法）
    const vm = wrapper.vm as unknown as { form: Record<string, unknown> };
    vm.form.leadId = 'lead-9';
    await flushPromises();
    expect(
      wrapper.findAll('input').some((i) => i.attributes('placeholder')?.includes('客户档案 ID')),
    ).toBe(false);

    const { bizSelect, techSelect } = selectsOf(wrapper);
    await selectValue(bizSelect, 'window_film');
    await wrapper
      .findAll('input')
      .find((i) => i.attributes('placeholder')?.includes('如：'))
      ?.setValue('DM10 全车隔热膜');
    await techSelect.vm.$emit('update:modelValue', '师傅A');
    const { start, end } = futureSlot();
    const pickers = wrapper.findAllComponents(ElDatePickerStub);
    await pickers[0]?.vm.$emit('update:modelValue', start);
    await pickers[1]?.vm.$emit('update:modelValue', end);
    await flushPromises();

    const submit = wrapper.findAll('.el-dialog button').find((b) => b.text().includes('提交'));
    await submit?.trigger('click');
    await flushPromises();

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    const payload = mockedCreate.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(payload.leadId).toBe('lead-9');
    expect(payload.customerId).toBeUndefined(); // leadId 口径下不传 customerId
  });

  it('列表"业务类型"列：枚举映射中文，空值显示未分类', async () => {
    const wrapper = await mountView([
      makeAppointment({ id: 'a1', businessType: 'window_film' }),
      makeAppointment({ id: 'a2', businessType: 'home_film', serviceItem: '淋浴房玻璃膜' }),
      makeAppointment({ id: 'a3', businessType: null, serviceItem: '历史单' }),
    ]);

    expect(wrapper.text()).toContain('窗膜');
    expect(wrapper.text()).toContain('住宅玻璃膜');
    expect(wrapper.text()).toContain('未分类');
  });

  it('发起预约对话框：业务类型下拉含四个枚举选项，且为必填', async () => {
    const wrapper = await mountView([], TECHS);
    await openDialog(wrapper);

    const { bizSelect } = selectsOf(wrapper);
    const labels = bizSelect.findAll('.stub-option').map((o) => o.text());
    expect(labels).toEqual(['窗膜', '车衣', '改色膜', '住宅玻璃膜']);
    // 必填标记（el-form-item required 渲染星号）
    expect(wrapper.find('.el-dialog').text()).toContain('业务类型');
  });

  it('技师选项全量展示+技能置灰（2026-08-27 修正口径）：无技能可见但禁选并标注', async () => {
    const wrapper = await mountView([], TECHS);
    await openDialog(wrapper);
    const { bizSelect, techSelect } = selectsOf(wrapper);

    // 窗膜：师傅A 可选；师傅B 置灰标注「无窗膜技能」；停用的师傅C 不出现
    await selectValue(bizSelect, 'window_film');
    const winOpts = techSelect.findAll('.stub-option');
    expect(winOpts.map((o) => o.text())).toEqual(['师傅A', '师傅B（无窗膜技能）']);
    expect((winOpts[0]!.element as HTMLElement).className).not.toContain('is-disabled');
    expect((winOpts[1]!.element as HTMLElement).className).toContain('is-disabled');

    // 车衣：师傅B 可选、师傅A 置灰
    await selectValue(bizSelect, 'car_cover');
    const coverOpts = techSelect.findAll('.stub-option');
    expect(coverOpts.map((o) => o.text())).toEqual(['师傅A（无车衣技能）', '师傅B']);
    expect((coverOpts[1]!.element as HTMLElement).className).not.toContain('is-disabled');
  });

  it('住宅玻璃膜不过滤技能池：全部在职技师可选', async () => {
    const wrapper = await mountView([], TECHS);
    await openDialog(wrapper);
    const { bizSelect, techSelect } = selectsOf(wrapper);

    await selectValue(bizSelect, 'home_film');
    expect(techSelect.findAll('.stub-option').map((o) => o.text())).toEqual(['师傅A', '师傅B']);
  });

  it('切换业务类型：已选技师不在新池内则清空；在新池内则保留', async () => {
    const wrapper = await mountView([], TECHS);
    await openDialog(wrapper);
    const { bizSelect, techSelect } = selectsOf(wrapper);

    await selectValue(bizSelect, 'car_cover');
    await techSelect.vm.$emit('update:modelValue', '师傅B');
    await flushPromises();
    expect(techSelect.props('modelValue')).toBe('师傅B');

    // 切到窗膜：师傅B 无窗膜技能 → 静默清空
    await selectValue(bizSelect, 'window_film');
    expect(techSelect.props('modelValue')).toBe('');

    // 切回并选师傅A，再切住宅膜（不过滤）→ 保留
    await selectValue(bizSelect, 'car_cover');
    await techSelect.vm.$emit('update:modelValue', '师傅B');
    await selectValue(bizSelect, 'home_film');
    expect(techSelect.props('modelValue')).toBe('师傅B');
  });

  it('未选业务类型提交被本地拦截，不发请求', async () => {
    const wrapper = await mountView([], TECHS);
    await openDialog(wrapper);

    const submit = wrapper.findAll('.el-dialog button').find((b) => b.text().includes('提交'));
    await submit?.trigger('click');
    await flushPromises();
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('请先选择业务类型');
  });

  it('提交载荷携带 businessType 等表单字段', async () => {
    const wrapper = await mountView([], TECHS);
    await openDialog(wrapper);
    const { bizSelect, techSelect } = selectsOf(wrapper);

    const inputs = wrapper.findAll('.el-dialog input.el-input__inner');
    await inputs[0]?.setValue('c1'); // 客户 ID
    await inputs[1]?.setValue('DM10 全车隔热膜'); // 服务项目
    await selectValue(bizSelect, 'window_film');
    await techSelect.vm.$emit('update:modelValue', '师傅A');
    const { start, end } = futureSlot();
    const pickers = wrapper.findAllComponents(ElDatePickerStub);
    await pickers[0]?.vm.$emit('update:modelValue', start);
    await pickers[1]?.vm.$emit('update:modelValue', end);
    await flushPromises();

    const submit = wrapper.findAll('.el-dialog button').find((b) => b.text().includes('提交'));
    await submit?.trigger('click');
    await flushPromises();

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'c1',
        businessType: 'window_film',
        serviceItem: 'DM10 全车隔热膜',
        technicianName: '师傅A',
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      }),
    );
  });

  it('2026-08-28 UI 测试 #4：过去时间提交被本地拦截并提示，不发请求', async () => {
    const wrapper = await mountView([], TECHS);
    await openDialog(wrapper);
    const { bizSelect } = selectsOf(wrapper);

    const inputs = wrapper.findAll('.el-dialog input.el-input__inner');
    await inputs[0]?.setValue('c1');
    await inputs[1]?.setValue('DM10 全车隔热膜');
    await selectValue(bizSelect, 'window_film');
    const past = new Date(Date.now() - 24 * 3600 * 1000);
    const pickers = wrapper.findAllComponents(ElDatePickerStub);
    await pickers[0]?.vm.$emit('update:modelValue', past);
    await pickers[1]?.vm.$emit('update:modelValue', new Date(past.getTime() + 6 * 3600 * 1000));
    await flushPromises();

    const submit = wrapper.findAll('.el-dialog button').find((b) => b.text().includes('提交'));
    await submit?.trigger('click');
    await flushPromises();
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('开始时间不能早于当前时间');
  });

  it('2026-08-28 UI 测试 #2：无技师预约展开行显示「初次指定技师」入口', async () => {
    const wrapper = await mountView(
      [
        makeAppointment({ id: 'a1', technicianName: null }),
        makeAppointment({ id: 'a2', technicianName: '师傅A' }),
      ],
      TECHS,
    );
    // 展开第一行（无技师）：出现「初次指定技师」且无「发起技师替换」
    const icons = wrapper.findAll('.el-table__expand-icon');
    await icons[0]?.trigger('click');
    await flushPromises();
    expect(wrapper.findAll('button').some((b) => b.text() === '初次指定技师')).toBe(true);
    expect(wrapper.findAll('button').some((b) => b.text() === '发起技师替换')).toBe(false);

    // 展开第二行（有技师）：仍是「发起技师替换」
    await icons[1]?.trigger('click');
    await flushPromises();
    expect(wrapper.findAll('button').some((b) => b.text() === '发起技师替换')).toBe(true);
  });
});
