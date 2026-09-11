import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { APPROVAL_STATUS, type ApprovalItem } from '../../api/approval';
import { useAuthStore } from '../../stores/auth';
import ApprovalCenterView, { rejectReasonValidator } from '../ApprovalCenterView.vue';

// mock api 模块：状态常量等保留真实实现，仅替换网络函数
const api = vi.hoisted(() => ({
  listApprovals: vi.fn(),
  createApproval: vi.fn(),
  approveApproval: vi.fn(),
  rejectApproval: vi.fn(),
  withdrawApproval: vi.fn(),
}));

vi.mock('../../api/approval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/approval')>();
  return { ...actual, ...api };
});

// 部分 mock element-plus：ElMessageBox 的 confirm/prompt 可控，组件照常渲染
const msgbox = vi.hoisted(() => ({
  confirm: vi.fn(),
  prompt: vi.fn(),
}));
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

function makeItem(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    id: 'ap-1',
    type: 'quote_discount',
    payload: { opportunityId: 'demo' },
    requesterId: 'u-sales',
    status: 'pending',
    opinion: null,
    basis: null,
    createdAt: '2026-08-12T00:00:00.000Z',
    decidedAt: null,
    ...overrides,
  };
}

async function mountView(options: { permissions?: string[]; userId?: string } = {}) {
  const pinia = createPinia();
  const auth = useAuthStore(pinia);
  auth.permissions = options.permissions ?? [];
  auth.user = {
    id: options.userId ?? 'u-boss',
    username: 'tester',
    displayName: '测试员',
  };
  const wrapper = mount(ApprovalCenterView, {
    global: { plugins: [ElementPlus, pinia] },
  });
  await flushPromises();
  return wrapper;
}

function buttonsWithText(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').filter((b) => b.text() === text);
}

describe('ApprovalCenterView 审批中心（P1-05 前端）', () => {
  it('2026-08-28 UI 测试 #9：排期审批标题不再误显「预约改期确认」，摘要列渲染 payload.summary', async () => {
    api.listApprovals.mockResolvedValue([
      makeItem({
        id: 'ap-sched',
        type: 'm07.schedule.confirm',
        payload: {
          appointmentId: 'apt-1',
          summary: '全车隐形车衣+前挡DM04｜08-29 12:00~16:00｜工位 A1',
        },
      }),
      makeItem({ id: 'ap-churn', type: 'lead.churn', payload: { reason: '预算不足放弃' } }),
    ]);
    const wrapper = await mountView({ permissions: ['approval:decide'] });

    expect(wrapper.text()).toContain('预约排期确认');
    expect(wrapper.text()).not.toContain('预约改期确认');
    // 盲批修复：业务摘要直接展示在列表（此前数据有、UI 不渲染）
    expect(wrapper.text()).toContain('全车隐形车衣+前挡DM04｜08-29 12:00~16:00｜工位 A1');
    // 无 summary 的审批兜底取 payload.reason
    expect(wrapper.text()).toContain('预算不足放弃');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    api.listApprovals.mockResolvedValue([]);
  });

  it('待审项渲染批准/驳回按钮（持 approval:decide）', async () => {
    api.listApprovals.mockResolvedValue([makeItem()]);
    const wrapper = await mountView({ permissions: ['approval:view', 'approval:decide'] });
    // 默认筛选=待审（历史留痕通过筛选器查看，不淹没待办）
    expect(api.listApprovals).toHaveBeenCalledWith(APPROVAL_STATUS.PENDING);
    expect(wrapper.text()).toContain('quote_discount');
    expect(buttonsWithText(wrapper, '批准')).toHaveLength(1);
    expect(buttonsWithText(wrapper, '驳回')).toHaveLength(1);
  });

  it('无 approval:decide 权限不渲染批准/驳回按钮', async () => {
    api.listApprovals.mockResolvedValue([makeItem()]);
    const wrapper = await mountView({ permissions: ['approval:view'] });
    expect(buttonsWithText(wrapper, '批准')).toHaveLength(0);
    expect(buttonsWithText(wrapper, '驳回')).toHaveLength(0);
  });

  it('本人发起的待审项渲染撤回；他人发起的不渲染撤回', async () => {
    api.listApprovals.mockResolvedValue([
      makeItem({ id: 'ap-mine', requesterId: 'u-sales' }),
      makeItem({ id: 'ap-other', requesterId: 'u-other' }),
    ]);
    const wrapper = await mountView({ permissions: ['approval:view'], userId: 'u-sales' });
    expect(buttonsWithText(wrapper, '撤回')).toHaveLength(1);
  });

  it('已决项不渲染任何操作按钮', async () => {
    api.listApprovals.mockResolvedValue([
      makeItem({ id: 'ap-done', status: 'approved', decidedAt: '2026-08-12T01:00:00.000Z' }),
    ]);
    const wrapper = await mountView({
      permissions: ['approval:view', 'approval:decide'],
      userId: 'u-sales',
    });
    expect(buttonsWithText(wrapper, '批准')).toHaveLength(0);
    expect(buttonsWithText(wrapper, '驳回')).toHaveLength(0);
    expect(buttonsWithText(wrapper, '撤回')).toHaveLength(0);
    expect(wrapper.text()).toContain('已批准');
  });

  it('批准：二次确认后调用 approve({confirmed:true}) 并刷新', async () => {
    api.listApprovals.mockResolvedValue([makeItem({ id: 'ap-9' })]);
    api.approveApproval.mockResolvedValue(makeItem({ id: 'ap-9', status: 'approved' }));
    msgbox.confirm.mockResolvedValue('confirm');
    const wrapper = await mountView({ permissions: ['approval:view', 'approval:decide'] });

    await buttonsWithText(wrapper, '批准')[0]?.trigger('click');
    await flushPromises();

    expect(msgbox.confirm).toHaveBeenCalledWith('确认批准该审批？', '二次确认');
    expect(api.approveApproval).toHaveBeenCalledWith('ap-9', { confirmed: true });
    // 成功后刷新列表（mounted 一次 + 批准成功一次）
    expect(api.listApprovals).toHaveBeenCalledTimes(2);
  });

  it('驳回：prompt 收集理由后调用 reject({confirmed:true, reason})', async () => {
    api.listApprovals.mockResolvedValue([makeItem({ id: 'ap-9' })]);
    api.rejectApproval.mockResolvedValue(makeItem({ id: 'ap-9', status: 'rejected' }));
    msgbox.prompt.mockResolvedValue({ value: '素材未授权，不能发布', action: 'confirm' });
    const wrapper = await mountView({ permissions: ['approval:view', 'approval:decide'] });

    await buttonsWithText(wrapper, '驳回')[0]?.trigger('click');
    await flushPromises();

    expect(msgbox.prompt).toHaveBeenCalledWith(
      '请填写驳回理由（≥5字）',
      '驳回',
      expect.objectContaining({ inputValidator: rejectReasonValidator }),
    );
    expect(api.rejectApproval).toHaveBeenCalledWith('ap-9', {
      confirmed: true,
      reason: '素材未授权，不能发布',
    });
  });

  it('驳回理由校验器：<5 字返回错误提示，≥5 字通过', () => {
    // 语义覆盖：inputValidator 返回字符串 = 拒绝并提示，返回 true = 通过
    expect(rejectReasonValidator('')).toBe('理由至少 5 个字');
    expect(rejectReasonValidator('不行')).toBe('理由至少 5 个字');
    expect(rejectReasonValidator('     ')).toBe('理由至少 5 个字');
    expect(rejectReasonValidator('素材未授权')).toBe(true);
    expect(rejectReasonValidator('  理由已充分  ')).toBe(true);
  });
});
