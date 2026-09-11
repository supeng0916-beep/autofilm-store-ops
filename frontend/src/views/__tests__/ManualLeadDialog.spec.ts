import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ManualLeadDialog from '../../components/lead/ManualLeadDialog.vue';
import { leadsApi, type Lead } from '../../api/leads';

// 对话框只测表单校验/查重/提交流：api 全量 mock，http 层不触达（AssetsUploadDialog.spec 模式）
vi.mock('../../api/leads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/leads')>();
  return {
    ...actual,
    leadsApi: {
      ...actual.leadsApi,
      register: vi.fn(),
      dupCheck: vi.fn(),
      assignableUsers: vi.fn(),
    },
  };
});

// 部分 mock element-plus（AssetsView.spec 模式）：ElMessageBox.confirm 可控，ElMessage 静音
const msgbox = vi.hoisted(() => ({ confirm: vi.fn() }));
const message = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('element-plus')>();
  return { ...actual, ElMessageBox: msgbox, ElMessage: message };
});

const mockedRegister = vi.mocked(leadsApi.register);
const mockedDupCheck = vi.mocked(leadsApi.dupCheck);
const mockedAssignable = vi.mocked(leadsApi.assignableUsers);

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1',
    leadNo: 'L-20260825-0001',
    customerName: '张三',
    sourcePlatform: '抖音',
    intentLevel: 'pending',
    stage: 'new',
    finalStatus: 'active',
    ownerUserId: null,
    nextStep: null,
    receivedAt: '2026-08-25T02:00:00.000Z',
    firstContactAttemptAt: null,
    ...overrides,
  };
}

async function mountDialog() {
  const wrapper = mount(ManualLeadDialog, {
    props: { modelValue: true },
    // ElSelect stub：happy-dom 下 EP select 递归更新（AssetsView.spec 同先例）
    global: { plugins: [ElementPlus], stubs: { teleport: true, ElSelect: true } },
  });
  await flushPromises();
  return wrapper;
}

/** 填一份最小合法表单（电话=13800001111），可覆盖个别字段 */
async function fillValidForm(
  wrapper: Awaited<ReturnType<typeof mountDialog>>,
  phone = '13800001111',
) {
  await wrapper.find('[data-testid="source-platform"]').setValue('抖音');
  await wrapper.find('[data-testid="phone-input"]').setValue(phone);
  const inputs = wrapper.findAll('input');
  const product = inputs.find((i) => i.attributes('placeholder')?.includes('客户明确询问'));
  await product!.setValue('全车隔热膜');
  const raw = wrapper.findAll('textarea')[0];
  await raw.setValue('刷到视频私信问价');
  await flushPromises();
}

describe('ManualLeadDialog 手工登记（2026-08-25 老板需求）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockedRegister.mockResolvedValue(makeLead());
    mockedDupCheck.mockResolvedValue({ duplicate: false });
    mockedAssignable.mockResolvedValue([
      { id: 'u-1', username: 'demo-sales-a', displayName: '销售甲' },
    ]);
    msgbox.confirm.mockResolvedValue('confirm');
  });

  it('打开即拉取可指定负责人；空表单提交被校验拦截不发请求', async () => {
    const wrapper = await mountDialog();
    expect(mockedAssignable).toHaveBeenCalled();

    await wrapper.find('[data-testid="submit-manual"]').trigger('click');
    await flushPromises();
    expect(mockedRegister).not.toHaveBeenCalled();
  });

  it('电话/微信全空：必填项齐全仍被「至少一项」拦截', async () => {
    const wrapper = await mountDialog();
    await fillValidForm(wrapper);
    await wrapper.find('[data-testid="phone-input"]').setValue('');
    await flushPromises();

    await wrapper.find('[data-testid="submit-manual"]').trigger('click');
    await flushPromises();
    expect(message.warning).toHaveBeenCalledWith('电话与微信至少填一项');
    expect(mockedRegister).not.toHaveBeenCalled();
  });

  it('实时查重：输入已存在电话出现疑似重复提示（含 leadNo）', async () => {
    vi.useFakeTimers();
    mockedDupCheck.mockResolvedValue({
      duplicate: true,
      lead: {
        id: 'lead-9',
        leadNo: 'L-20260820-0007',
        customerName: '老客户',
        stage: 'communicating',
        receivedAt: '2026-08-20T02:00:00.000Z',
      },
    });
    const wrapper = await mountDialog();
    await wrapper.find('[data-testid="phone-input"]').setValue('13800001111');
    await vi.advanceTimersByTimeAsync(600);
    await flushPromises();
    vi.useRealTimers();

    expect(mockedDupCheck).toHaveBeenCalledWith({ phone: '13800001111' });
    expect(wrapper.find('[data-testid="dup-warning"]').text()).toContain('L-20260820-0007');
    expect(wrapper.find('[data-testid="dup-warning"]').text()).toContain('老客户');
  });

  it('无重复：直接登记成功并 emit created', async () => {
    const wrapper = await mountDialog();
    await fillValidForm(wrapper);

    await wrapper.find('[data-testid="submit-manual"]').trigger('click');
    await flushPromises();
    expect(msgbox.confirm).not.toHaveBeenCalled();
    expect(mockedRegister).toHaveBeenCalledTimes(1);
    const payload = mockedRegister.mock.calls[0][0];
    expect(payload).toMatchObject({
      sourceCategory: 'online',
      sourcePlatform: '抖音',
      phone: '13800001111',
      productNeed: '全车隔热膜',
      wechatType: 'real',
    });
    expect(payload.ownerUserId).toBeUndefined(); // 默认自动分派不传
    expect(wrapper.emitted('created')?.[0]?.[0]).toMatchObject({ leadNo: 'L-20260825-0001' });
  });

  it('疑似重复：确认后仍登记（携带电话），取消则不发请求', async () => {
    mockedDupCheck.mockResolvedValue({
      duplicate: true,
      lead: {
        id: 'lead-9',
        leadNo: 'L-20260820-0007',
        customerName: '老客户',
        stage: 'communicating',
        receivedAt: '2026-08-20T02:00:00.000Z',
      },
    });
    const wrapper = await mountDialog();
    await fillValidForm(wrapper);
    await new Promise((r) => setTimeout(r, 700)); // 等防抖查重落定
    await flushPromises();

    // 取消路径
    msgbox.confirm.mockRejectedValueOnce('cancel');
    await wrapper.find('[data-testid="submit-manual"]').trigger('click');
    await flushPromises();
    expect(mockedRegister).not.toHaveBeenCalled();

    // 确认路径
    await wrapper.find('[data-testid="submit-manual"]').trigger('click');
    await flushPromises();
    expect(mockedRegister).toHaveBeenCalledWith(expect.objectContaining({ phone: '13800001111' }));
  });
});
