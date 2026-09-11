import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import LeadDetailView from '../LeadDetailView.vue';

// mock api：页面不发真实请求，行为逐用例指定（与 LeadsQueueView.spec 同模式）
const api = vi.hoisted(() => ({
  getDetail: vi.fn(),
  events: vi.fn(),
  aiSummary: vi.fn(),
  summaryRegenerate: vi.fn(),
  classifySubmit: vi.fn(),
  listDrafts: vi.fn(),
  createDraft: vi.fn(),
  patchDraft: vi.fn(),
  copyDraft: vi.fn(),
  sendRecord: vi.fn(),
  summaryFeedback: vi.fn(),
  contactAttempt: vi.fn(),
  customerReply: vi.fn(),
  transitionStage: vi.fn(),
  proposeChurn: vi.fn(),
  recordFollowUp: vi.fn(),
  intentProposals: vi.fn(),
  intentConfirm: vi.fn(),
}));
vi.mock('../../api/leads', () => ({ leadsApi: api }));
// mock 订单确认 api（批次1 Task 8）：byLead/create/confirm 逐用例指定
const orderApi = vi.hoisted(() => ({
  byLead: vi.fn(),
  create: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('../../api/order', () => ({ orderApi }));
vi.mock('../../composables/usePermission', () => ({ usePermission: () => ({ can: () => true }) }));

// 部分 mock element-plus（AssetsView.spec 模式）：ElMessageBox.confirm 可控、ElMessage 静音
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

const DETAIL = {
  id: 'l1',
  leadNo: 'L-20260814-0001',
  customerName: '张三',
  sourcePlatform: '抖音',
  intentLevel: 'high',
  stage: 'new',
  finalStatus: 'active',
  ownerUserId: 'u1',
  nextStep: null,
  receivedAt: '2026-08-14T09:00:00.000Z',
  firstContactAttemptAt: null,
  sourceCategory: 'online',
  businessType: 'auto_film',
  target: '特斯拉 Model Y',
  productNeed: '改色膜',
  rawNeed: '想贴改色膜',
  chatLink: null,
  phone: '13800138000',
  wechat: null,
  dueAt: null,
  assignedAt: null,
  nextFollowUpAt: null,
  firstCustomerReplyAt: null,
  lastFollowUpResult: null,
  sla: { state: 'ok', dueInMinutes: 15 },
};

const DRAFT = {
  taskId: 't1',
  version: 0,
  text: '您好，我是AutoFilm Demo的小周，看到您对改色膜有兴趣，方便到店看下色卡吗？',
  source: 'ai',
  notes: null,
  createdAt: '2026-08-14T09:00:00.000Z',
};

// —— 批次1 Task 8 订单确认卡片夹具 ——
const WON_DETAIL = { ...DETAIL, finalStatus: 'won' };

const ORDER_DRAFT = {
  id: 'oc1',
  leadId: 'l1',
  appointmentId: null,
  products: '演示品牌 DM04 前挡 + DM13 侧后挡',
  quoteSnapshot: 'DM04 前挡 3200 元；DM13 侧后挡 2800 元；合计 6000 元',
  discountNote: '老客户转介绍减 200',
  depositFen: 50000,
  balanceFen: 550000,
  materialCostFen: 300000,
  payMethod: 'wechat',
  status: 'draft',
  customerConfirmedAt: null,
  createdAt: '2026-08-30T02:00:00.000Z',
};

async function mountView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/leads/:id', component: { template: '<div />' } }],
  });
  await router.push('/leads/l1');
  await router.isReady();
  const wrapper = mount(LeadDetailView, {
    global: { plugins: [ElementPlus, router] },
  });
  await flushPromises();
  return wrapper;
}

/** 安装可写剪贴板替身（jsdom 默认无 navigator.clipboard） */
function stubClipboard(writeText: () => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

describe('LeadDetailView 客资详情（P3-06 前端）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getDetail.mockResolvedValue(DETAIL);
    api.events.mockResolvedValue([]);
    // 2026-08-26 O8 缺口：aiSummary/intentProposals 均为状态视图 {status, ...}
    api.aiSummary.mockResolvedValue({ status: 'none', summary: null });
    api.intentProposals.mockResolvedValue({ status: 'none', proposal: null });
    api.listDrafts.mockResolvedValue([]);
    // 批次1 Task 8：默认无订单确认单（已成交客资才发请求）
    orderApi.byLead.mockResolvedValue(null);
  });

  it('渲染草稿工作区（生成/编辑/一键复制/历史列表）', async () => {
    api.listDrafts.mockResolvedValue([DRAFT]);
    const wrapper = await mountView();

    expect(api.getDetail).toHaveBeenCalledWith('l1');
    expect(wrapper.text()).toContain('客资信息');
    expect(wrapper.text()).toContain('草稿工作区');
    expect(wrapper.text()).toContain('生成草稿');
    expect(wrapper.text()).toContain('一键复制');
    expect(wrapper.text()).toContain('历史草稿');
  });

  it('复制按钮：navigator.clipboard 成功后才发 copy 请求', async () => {
    api.listDrafts.mockResolvedValue([DRAFT]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    const wrapper = await mountView();
    const copyBtn = wrapper.findAll('button').find((b) => b.text().includes('一键复制'));
    expect(copyBtn).toBeTruthy();

    await copyBtn!.trigger('click');
    await flushPromises();

    expect(writeText).toHaveBeenCalledWith(DRAFT.text);
    expect(api.copyDraft).toHaveBeenCalledWith('l1', 't1');
  });

  it('剪贴板写入失败时不发 copy 请求（已复制≠已发送，无复制证据不记）', async () => {
    api.listDrafts.mockResolvedValue([DRAFT]);
    stubClipboard(vi.fn().mockRejectedValue(new Error('clipboard denied')));

    const wrapper = await mountView();
    const copyBtn = wrapper.findAll('button').find((b) => b.text().includes('一键复制'));
    await copyBtn!.trigger('click');
    await flushPromises();

    expect(api.copyDraft).not.toHaveBeenCalled();
  });

  it('发送对话框无证据时提交禁用，≥10 字后可用', async () => {
    api.listDrafts.mockResolvedValue([DRAFT]);
    const wrapper = await mountView();

    const trigger = wrapper.findAll('button').find((b) => b.text().includes('记录为已发送'));
    expect(trigger).toBeTruthy();
    await trigger!.trigger('click');
    await flushPromises();

    // 对话框渲染在 wrapper 内（本测试环境不 teleport 到 body）
    const submit = wrapper.findAll('button').find((b) => b.text().includes('确认已发送'));
    expect(submit).toBeTruthy();
    expect((submit!.element as HTMLButtonElement).disabled).toBe(true);

    const textarea = wrapper
      .findAll('textarea')
      .find((t) => t.attributes('placeholder')?.includes('实际发送的证据'));
    expect(textarea).toBeTruthy();
    await textarea!.setValue('已微信发送跟进消息，客户回复了再约时间');
    await flushPromises();

    expect((submit!.element as HTMLButtonElement).disabled).toBe(false);
  });

  it('AI 摘要反馈：采用调 summaryFeedback 并回显状态（老板反馈「按钮无反应」回归）', async () => {
    api.aiSummary.mockResolvedValue({
      status: 'done',
      summary: {
        taskId: 't1',
        summary: '客户咨询改色膜',
        concerns: [],
        questionsToAsk: [],
        nextAction: '微信首触',
        createdAt: '2026-08-25T02:00:00.000Z',
        feedback: null,
      },
    });
    api.summaryFeedback.mockResolvedValue({
      id: 'f1',
      taskId: 't1',
      decision: 'adopted',
      createdAt: new Date(),
    });
    const wrapper = await mountView();

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('采用'))!
      .trigger('click');
    await flushPromises();
    expect(api.summaryFeedback).toHaveBeenCalledWith('l1', { decision: 'adopted' });
    expect(message.success).toHaveBeenCalled();
  });

  it('AI 摘要修改：弹说明对话框，≥2 字提交 modified+note', async () => {
    api.aiSummary.mockResolvedValue({
      status: 'done',
      summary: {
        taskId: 't1',
        summary: '客户咨询改色膜',
        concerns: [],
        questionsToAsk: [],
        nextAction: '微信首触',
        createdAt: '2026-08-25T02:00:00.000Z',
        feedback: null,
      },
    });
    const wrapper = await mountView();

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('修改'))!
      .trigger('click');
    await flushPromises();
    await wrapper
      .find('[data-testid="summary-modify-note"]')
      .setValue('意向判断有误，客户明确本周到店');
    const submitBtn = wrapper.findAll('button').find((b) => b.text().includes('提交修改说明'))!;
    await submitBtn.trigger('click');
    await flushPromises();
    expect(api.summaryFeedback).toHaveBeenCalledWith('l1', {
      decision: 'modified',
      note: '意向判断有误，客户明确本周到店',
    });
  });

  it('登记首次触达：确认后调 contactAttempt（SLA 止表入口回归）', async () => {
    msgbox.confirm.mockResolvedValue('confirm');
    api.contactAttempt.mockResolvedValue({ id: 'l1', firstContactAttemptAt: new Date() });
    const wrapper = await mountView();

    await wrapper.find('[data-testid="contact-attempt-btn"]').trigger('click');
    await flushPromises();
    expect(api.contactAttempt).toHaveBeenCalledWith('l1');
    expect(message.success).toHaveBeenCalled();
  });

  it('客户已回复：直接调 customerReply', async () => {
    api.customerReply.mockResolvedValue({ id: 'l1', firstCustomerReplyAt: new Date() });
    const wrapper = await mountView();

    await wrapper.find('[data-testid="customer-reply-btn"]').trigger('click');
    await flushPromises();
    expect(api.customerReply).toHaveBeenCalledWith('l1');
  });

  // ── 2026-08-26 O8 评测缺口回归：三态空态 + 轮询 + 一键重提/生成 ──

  it('AI 建议在途：显示生成中态并轮询，双双落定后停止轮询', async () => {
    vi.useFakeTimers();
    try {
      api.aiSummary.mockResolvedValue({ status: 'pending', summary: null });
      api.intentProposals.mockResolvedValue({ status: 'pending', proposal: null });
      const wrapper = await mountView();

      // 登记后立即打开：生成中态而非「暂无」（O8 评测误判根因）
      expect(wrapper.find('[data-testid="summary-pending"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="proposal-pending"]').exists()).toBe(true);
      expect(wrapper.text()).not.toContain('暂无 AI 摘要');

      // 第一轮轮询：摘要落定、分级仍在途 → 摘要内容显示、分级继续转圈
      api.aiSummary.mockResolvedValue({
        status: 'done',
        summary: {
          taskId: 't9',
          summary: '客户想贴膜，意向中',
          concerns: [],
          questionsToAsk: [],
          nextAction: '邀约到店',
          createdAt: '2026-08-26T08:00:00.000Z',
        },
      });
      await vi.advanceTimersByTimeAsync(5000);
      await flushPromises();
      expect(wrapper.text()).toContain('客户想贴膜');
      expect(wrapper.find('[data-testid="proposal-pending"]').exists()).toBe(true);

      // 第二轮：分级也落定 → 建议等级渲染，轮询停止（后续 interval 不再请求）
      api.intentProposals.mockResolvedValue({
        status: 'done',
        proposal: {
          taskId: 't10',
          level: 'mid',
          confidence: 0.8,
          evidence: ['主动问价'],
          missingInfo: [],
          createdAt: '2026-08-26T08:00:05.000Z',
        },
      });
      await vi.advanceTimersByTimeAsync(5000);
      await flushPromises();
      expect(wrapper.text()).toContain('建议等级');
      const callsAtStop = api.aiSummary.mock.calls.length;
      await vi.advanceTimersByTimeAsync(15000);
      expect(api.aiSummary.mock.calls.length).toBe(callsAtStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it('摘要生成失败（degraded 无内容）：一键重新生成调 summaryRegenerate', async () => {
    api.aiSummary.mockResolvedValue({ status: 'degraded', summary: null });
    api.summaryRegenerate.mockResolvedValue({ taskId: 't2', status: 'pending' });
    const wrapper = await mountView();

    const btn = wrapper.find('[data-testid="summary-generate-btn"]');
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toContain('重新生成');
    await btn.trigger('click');
    await flushPromises();
    expect(api.summaryRegenerate).toHaveBeenCalledWith('l1');
    expect(message.success).toHaveBeenCalled();
  });

  it('最新失败仍回旧摘要：展示旧摘要＋失败提示＋重新生成按钮', async () => {
    api.aiSummary.mockResolvedValue({
      status: 'degraded',
      summary: {
        taskId: 't1',
        summary: '旧版摘要：客户咨询改色膜',
        concerns: [],
        questionsToAsk: [],
        nextAction: '微信首触',
        createdAt: '2026-08-25T02:00:00.000Z',
        feedback: null,
      },
    });
    const wrapper = await mountView();

    expect(wrapper.text()).toContain('旧版摘要：客户咨询改色膜');
    expect(wrapper.text()).toContain('最新一次生成失败');
    expect(wrapper.find('[data-testid="summary-regenerate-btn"]').exists()).toBe(true);
  });

  it('暂无分级建议：一键生成调 classifySubmit（分配触发的兜底入口）', async () => {
    api.classifySubmit.mockResolvedValue({ taskId: 't3', status: 'pending' });
    const wrapper = await mountView();

    const btn = wrapper.find('[data-testid="proposal-generate-btn"]');
    expect(btn.exists()).toBe(true);
    await btn.trigger('click');
    await flushPromises();
    expect(api.classifySubmit).toHaveBeenCalledWith('l1');
    expect(message.success).toHaveBeenCalled();
  });

  // ── 批次1 Task 8：订单确认卡片（仅已成交客资显示，金额分存元显） ──

  describe('订单确认卡片（批次1 Task 8）', () => {
    it('已成交客资渲染订单确认创建卡片；未成交不显示也不发请求', async () => {
      api.getDetail.mockResolvedValue(WON_DETAIL);
      const wrapper = await mountView();

      expect(orderApi.byLead).toHaveBeenCalledWith('l1');
      expect(wrapper.text()).toContain('订单确认');
      expect(wrapper.text()).toContain('产品/服务范围');
      expect(wrapper.text()).toContain('报价快照');
      expect(wrapper.text()).toContain('定金（元）');
      expect(wrapper.text()).toContain('尾款（元）');
      expect(wrapper.text()).toContain('付款方式');
      expect(wrapper.find('[data-testid="order-submit"]').exists()).toBe(true);

      // 未成交（finalStatus=active）：卡片不渲染、不发订单请求
      api.getDetail.mockResolvedValue(DETAIL);
      const plain = await mountView();
      expect(plain.text()).not.toContain('订单确认');
      expect(orderApi.byLead).toHaveBeenCalledTimes(1);
    });

    it('创建提交金额元转分（定金输入 500 → depositFen 50000）', async () => {
      api.getDetail.mockResolvedValue(WON_DETAIL);
      orderApi.create.mockResolvedValue(ORDER_DRAFT);
      const wrapper = await mountView();

      // el-input 的 attrs（含 data-testid）透传到内层 textarea/input 本体
      await wrapper.find('[data-testid="order-products"]').setValue('演示品牌 DM04 前挡');
      await wrapper
        .find('[data-testid="order-quote"]')
        .setValue('DM04 前挡 3200 元；DM13 侧后挡 2800 元');
      await wrapper.find('[data-testid="order-discount"]').setValue('老客户转介绍减 200');
      await wrapper.find('[data-testid="order-deposit"] input').setValue('500');
      await wrapper.find('[data-testid="order-balance"] input').setValue('5500');
      // 批次4：材料成本元转分（500 → 50000），选填字段录入后随提交携带
      await wrapper.find('[data-testid="order-material-cost"] input').setValue('500');
      // el-select 下拉 teleport 到 body：点 wrapper 展开后从 document 里选「微信」
      await wrapper.find('[data-testid="order-pay-method"] .el-select__wrapper').trigger('click');
      await flushPromises();
      // 只从当前展开（aria-hidden=false）的弹层取选项，避免命中早先挂载残留的隐藏弹层
      const wechat = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.el-select__popper[aria-hidden="false"] .el-select-dropdown__item',
        ),
      ).find((el) => el.textContent === '微信');
      expect(wechat).toBeTruthy();
      wechat!.click();
      await flushPromises();

      await wrapper.find('[data-testid="order-submit"]').trigger('click');
      await flushPromises();

      expect(orderApi.create).toHaveBeenCalledWith({
        leadId: 'l1',
        products: '演示品牌 DM04 前挡',
        quoteSnapshot: 'DM04 前挡 3200 元；DM13 侧后挡 2800 元',
        discountNote: '老客户转介绍减 200',
        depositFen: 50000,
        balanceFen: 550000,
        materialCostFen: 50000, // 材料成本 500 元 × 100 转分
        payMethod: 'wechat',
      });
      // 创建成功后切换为只读快照（draft=待确认）
      expect(wrapper.text()).toContain('待确认');
      expect(wrapper.find('[data-testid="order-submit"]').exists()).toBe(false);
    });

    it('材料成本未录入（选填，批次4）：提交省略 materialCostFen 键', async () => {
      api.getDetail.mockResolvedValue(WON_DETAIL);
      orderApi.create.mockResolvedValue({ ...ORDER_DRAFT, materialCostFen: null });
      const wrapper = await mountView();

      await wrapper.find('[data-testid="order-products"]').setValue('演示品牌 DM04 前挡');
      await wrapper.find('[data-testid="order-quote"]').setValue('合计 6000 元');
      await wrapper.find('[data-testid="order-submit"]').trigger('click');
      await flushPromises();

      expect(orderApi.create).toHaveBeenCalledTimes(1);
      const payload = orderApi.create.mock.calls[0][0] as Record<string, unknown>;
      expect('materialCostFen' in payload).toBe(false); // 未录入不传该键（后端存 null）
    });

    it('confirmed 只读：金额按元显示（分÷100）+ 已确认 tag + 确认时间', async () => {
      api.getDetail.mockResolvedValue(WON_DETAIL);
      orderApi.byLead.mockResolvedValue({
        ...ORDER_DRAFT,
        status: 'confirmed',
        customerConfirmedAt: '2026-08-30T06:00:00.000Z',
      });
      const wrapper = await mountView();

      // 锁定订单确认卡片本身（AI 面板也有「已确认」文案，断言限定在卡片内）
      const card = wrapper.findAll('section').find((s) => s.classes().includes('order-card'));
      expect(card).toBeTruthy();
      expect(card!.find('.el-tag').text()).toBe('已确认');
      expect(card!.text()).toContain('演示品牌 DM04 前挡 + DM13 侧后挡');
      expect(card!.text()).toContain('500.00'); // 定金 50000 分 ÷ 100
      expect(card!.text()).toContain('5500.00'); // 尾款 550000 分 ÷ 100
      expect(card!.text()).toContain('材料成本（元）'); // 批次4：材料成本 300000 分 ÷ 100
      expect(card!.text()).toContain('3000.00');
      expect(card!.text()).toContain('微信');
      expect(card!.text()).toContain('老客户转介绍减 200');
      expect(card!.text()).toContain('确认时间');
      // 只读态无表单、无确认按钮
      expect(wrapper.find('[data-testid="order-products"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="order-submit"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="order-confirm-btn"]').exists()).toBe(false);
    });

    it('只读区材料成本未录入显示"—"（批次4）', async () => {
      api.getDetail.mockResolvedValue(WON_DETAIL);
      orderApi.byLead.mockResolvedValue({ ...ORDER_DRAFT, materialCostFen: null });
      const wrapper = await mountView();

      const card = wrapper.findAll('section').find((s) => s.classes().includes('order-card'));
      expect(card).toBeTruthy();
      expect(card!.text()).toContain('材料成本（元）');
      expect(card!.text()).toContain('材料成本（元）—');
    });

    it('draft 态显示确认订单按钮，确认后刷新为 confirmed', async () => {
      api.getDetail.mockResolvedValue(WON_DETAIL);
      orderApi.byLead.mockResolvedValue(ORDER_DRAFT);
      orderApi.confirm.mockResolvedValue({
        ...ORDER_DRAFT,
        status: 'confirmed',
        customerConfirmedAt: '2026-08-30T06:00:00.000Z',
      });
      const wrapper = await mountView();

      expect(wrapper.text()).toContain('待确认');
      const btn = wrapper.find('[data-testid="order-confirm-btn"]');
      expect(btn.exists()).toBe(true);
      await btn.trigger('click');
      await flushPromises();

      expect(orderApi.confirm).toHaveBeenCalledWith('oc1');
      const card = wrapper.findAll('section').find((s) => s.classes().includes('order-card'));
      expect(card!.find('.el-tag').text()).toBe('已确认');
      expect(wrapper.find('[data-testid="order-confirm-btn"]').exists()).toBe(false);
    });

    it('订单确认单查询失败不阻断详情页（容错同既有风格）', async () => {
      api.getDetail.mockResolvedValue(WON_DETAIL);
      orderApi.byLead.mockRejectedValue(new Error('network down'));
      const wrapper = await mountView();

      expect(wrapper.text()).toContain('客资信息');
      expect(wrapper.text()).toContain('草稿工作区');
    });
  });
});
