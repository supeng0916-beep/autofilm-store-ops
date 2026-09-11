import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import { appointmentApi, type Appointment } from '../../api/appointment';
import { overview, type TechnicianCard } from '../../api/team';
import { workOrderApi } from '../../api/workOrder';
import WorkOrdersView from '../WorkOrdersView.vue';

// 权限 composable 整体 mock（AppointmentsView.spec 口径）：建单入口走 can('m08:edit')
const { canMock } = vi.hoisted(() => ({ canMock: vi.fn<(perm: string) => boolean>() }));
vi.mock('../../composables/usePermission', () => ({
  usePermission: () => ({ can: canMock }),
}));

vi.mock('../../api/appointment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/appointment')>();
  return { ...actual, appointmentApi: { list: vi.fn() } };
});
vi.mock('../../api/team', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/team')>();
  return { ...actual, overview: vi.fn() };
});
vi.mock('../../api/workOrder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/workOrder')>();
  return { ...actual, workOrderApi: { ...actual.workOrderApi, list: vi.fn(), create: vi.fn() } };
});

const mockedList = vi.mocked(appointmentApi.list);
const mockedOverview = vi.mocked(overview);
const mockedCreate = vi.mocked(workOrderApi.create);
const mockedWoList = vi.mocked(workOrderApi.list);

/** ElSelect/ElOption 轻量 stub（AppointmentsView.spec 先例）：保 slot 渲染断言选项与置灰态 */
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

function makeAppointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 'a1',
    leadId: null,
    customerId: 'c1',
    opportunityId: null,
    businessType: 'car_cover',
    serviceItem: '全车车衣',
    workbench: null,
    technicianName: null,
    technicianDesignated: false,
    estHours: null,
    startAt: '2026-08-21T02:00:00.000Z',
    endAt: '2026-08-21T08:00:00.000Z',
    promise: null,
    managerConfirmed: true,
    managerConfirmedBy: null,
    managerConfirmedAt: null,
    status: 'confirmed',
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
  makeTechnician({ id: 't1', name: '技师甲', skills: ['window_film'] }),
  makeTechnician({ id: 't2', name: '技师己', skills: ['car_cover', 'color_change'] }),
  makeTechnician({ id: 't3', name: '停用师傅', skills: ['car_cover'], active: false }),
];

async function mountView(appointments: Appointment[] = []) {
  mockedWoList.mockResolvedValue([]);
  mockedList.mockResolvedValue(appointments);
  mockedOverview.mockResolvedValue({ technicians: TECHS, agents: [], records: [] });
  mockedCreate.mockResolvedValue({} as never);
  canMock.mockImplementation((perm: string) => perm === 'm08:edit');
  const wrapper = mount(WorkOrdersView, {
    global: {
      plugins: [ElementPlus],
      stubs: { ElSelect: ElSelectStub, ElOption: ElOptionStub },
    },
  });
  await flushPromises();
  const btn = wrapper.findAll('button').find((b) => b.text().includes('建施工单'));
  await btn?.trigger('click');
  await flushPromises();
  return wrapper;
}

/** 建单弹窗内两个下拉：[0]=预约 [1]=技师（模板顺序） */
function selectsOf(wrapper: ReturnType<typeof mount>) {
  const selects = wrapper.findAllComponents(ElSelectStub);
  return { apptSelect: selects[0], techSelect: selects[1] };
}

async function selectAppt(wrapper: ReturnType<typeof mount>, id: string) {
  const { apptSelect } = selectsOf(wrapper);
  await apptSelect.vm.$emit('update:modelValue', id);
  await apptSelect.vm.$emit('change', id);
  await flushPromises();
}

describe('WorkOrdersView 建单技师选择（2026-08-28 P1 技能过滤）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('无技师预约：技师全量展示+技能置灰——车衣单下窗膜师傅可选性正确，停用技师不出现', async () => {
    const wrapper = await mountView([makeAppointment({ id: 'a1' })]);
    await selectAppt(wrapper, 'a1');
    const { techSelect } = selectsOf(wrapper);

    // 车衣预约：技师甲（仅窗膜）置灰并标注；技师己（车衣）可选；停用师傅不出现
    const opts = techSelect.findAll('.stub-option');
    expect(opts.map((o) => o.text())).toEqual(['技师甲（无车衣技能）', '技师己']);
    expect((opts[0]!.element as HTMLElement).className).toContain('is-disabled');
    expect((opts[1]!.element as HTMLElement).className).not.toContain('is-disabled');
  });

  it('住宅玻璃膜预约不过滤技能池：全部在职技师可选', async () => {
    const wrapper = await mountView([makeAppointment({ id: 'a2', businessType: 'home_film' })]);
    await selectAppt(wrapper, 'a2');
    const { techSelect } = selectsOf(wrapper);

    const opts = techSelect.findAll('.stub-option');
    expect(opts.map((o) => o.text())).toEqual(['技师甲', '技师己']);
    expect(opts.every((o) => !(o.element as HTMLElement).className.includes('is-disabled'))).toBe(
      true,
    );
  });

  it('切换预约清空已选技师（避免沿用上一单的技能错配选择）', async () => {
    const wrapper = await mountView([
      makeAppointment({ id: 'a1', businessType: 'car_cover' }),
      makeAppointment({ id: 'a2', businessType: 'window_film' }),
    ]);
    await selectAppt(wrapper, 'a1');
    const { techSelect } = selectsOf(wrapper);

    await techSelect.vm.$emit('update:modelValue', '技师己');
    await flushPromises();
    expect(techSelect.props('modelValue')).toBe('技师己');

    // 换窗膜预约：已选技师清空，窗膜单下技师己置灰
    await selectAppt(wrapper, 'a2');
    expect(techSelect.props('modelValue')).toBe('');
    const opts = techSelect.findAll('.stub-option');
    expect(opts.map((o) => o.text())).toEqual(['技师甲', '技师己（无窗膜技能）']);
  });
});
