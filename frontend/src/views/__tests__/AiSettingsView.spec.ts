import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus, { ElAlert, ElButton, ElProgress, ElSwitch } from 'element-plus';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AiBudgetStatus,
  AiCostBreakdownRow,
  AiDailyCost,
  AiSwitchSnapshot,
  ShadowDraftSummary,
  ShadowIntentSummary,
} from '../../api/ai';
import { useAuthStore } from '../../stores/auth';
import AiSettingsView from '../AiSettingsView.vue';

// mock api 模块：页面不发真实请求，快照/成本逐用例指定
const api = vi.hoisted(() => ({
  fetchAiStatus: vi.fn(),
  fetchAiSwitches: vi.fn(),
  setAiSwitch: vi.fn(),
  fetchAiDailyCosts: vi.fn(),
  fetchAiBudgetStatus: vi.fn(),
  fetchAiCostBreakdown: vi.fn(),
  setAiDailyBudget: vi.fn(),
  fetchShadowIntent: vi.fn(),
  fetchShadowDraft: vi.fn(),
  fetchSkillVersions: vi.fn(),
  harvestShadowExperience: vi.fn(),
}));
vi.mock('../../api/ai', () => api);

// 系统运维（2026-08-26 重启按钮；2026-08-27 补备份/诊断/版本）：mock 全部导出形状
const systemMock = vi.hoisted(() => ({
  restartServices: vi.fn(),
  pingHealth: vi.fn(),
  runBackup: vi.fn(),
  backupStatus: vi.fn(),
  diagnostics: vi.fn(),
  fetchHealthInfo: vi.fn(),
  downloadDiagnostics: vi.fn(),
}));
vi.mock('../../api/system', () => ({
  systemApi: {
    restartServices: systemMock.restartServices,
    runBackup: systemMock.runBackup,
    backupStatus: systemMock.backupStatus,
    diagnostics: systemMock.diagnostics,
  },
  pingHealth: systemMock.pingHealth,
  fetchHealthInfo: systemMock.fetchHealthInfo,
  downloadDiagnostics: systemMock.downloadDiagnostics,
}));

// 部分 mock element-plus：ElMessageBox 的 confirm/prompt 可控，组件照常渲染（同 ApprovalCenterView.spec）
const msgbox = vi.hoisted(() => ({ confirm: vi.fn(), prompt: vi.fn() }));
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

const SNAPSHOT: AiSwitchSnapshot = { global: true, skills: [{ taskType: 'hello', enabled: true }] };
const COSTS: AiDailyCost[] = [
  { date: '2026-08-12', taskCount: 3, tokensIn: 1000, tokensOut: 500, costFen: 1234 },
];
/** 正常区间：已用 50 元 / 预算 100 元（低于 warn 80 元、alert 95 元） */
const STATUS: AiBudgetStatus = {
  date: '2026-08-20',
  spentFen: 5000,
  budgetFen: 10000,
  warnFen: 8000,
  alertFen: 9500,
};
const BREAKDOWN: AiCostBreakdownRow[] = [
  {
    date: '2026-08-19',
    model: 'qwen-plus',
    taskType: 'hello',
    taskCount: 2,
    tokensIn: 1000,
    tokensOut: 500,
    costFen: 2345,
  },
];
/** 影子模式·话术对比（阶段三 B2）：一条改写样本 + 一条照发样本（verbatimCandidates 命中） */
const SHADOW_DRAFT: ShadowDraftSummary = {
  days: 30,
  total: 2,
  avgSimilarity: 0.86,
  verbatimRate: 0.5,
  samples: [
    {
      taskId: 't-edit',
      leadId: 'l1',
      similarity: 0.72,
      original: '哥，膜贴好了来看下',
      actual: '李哥，您 Model Y 的膜贴好了',
    },
    {
      taskId: 't-verbatim',
      leadId: 'l2',
      similarity: 1,
      original: '姐，本周到店贴膜送全车镀晶体验',
      actual: '姐，本周到店贴膜送全车镀晶体验',
    },
  ],
  verbatimCandidates: [
    { taskId: 't-verbatim', leadId: 'l2', original: '姐，本周到店贴膜送全车镀晶体验' },
  ],
};
/** 影子模式·意向对比：一条改判样本（带 leadNo 展示） */
const SHADOW_INTENT: ShadowIntentSummary = {
  days: 30,
  total: 1,
  agreed: 0,
  agreementRate: 0,
  overrides: [{ aiLevel: 'B', humanLevel: 'A', count: 1 }],
  overrideSamples: [
    { leadId: 'l3', leadNo: 'L-SH-3', aiLevel: 'B', humanLevel: 'A', reason: '客户已到店实车看膜' },
  ],
};

async function mountView(options: { permissions?: string[]; roles?: string[] } = {}) {
  const pinia = createPinia();
  const auth = useAuthStore(pinia);
  auth.permissions = options.permissions ?? ['system:manage', 'ai:cost:view'];
  // 默认测试用户带 boss 角色（与默认全权限同口径）；提额按钮按角色而非权限点门控
  auth.roles = options.roles ?? ['boss'];
  const wrapper = mount(AiSettingsView, { global: { plugins: [ElementPlus, pinia] } });
  await flushPromises();
  return wrapper;
}

/** 页面开关顺序：全局总开关在前，随后按 skills 顺序 */
function switchesOf(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAllComponents(ElSwitch);
}

/** 段首横幅内的「临时提额」按钮 */
function raiseButtonOf(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAllComponents(ElButton).find((b) => b.text().includes('临时提额'));
}

describe('AiSettingsView AI 通道管理（P2-09）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchAiStatus.mockResolvedValue({
      globalEnabled: true,
      healthy: true,
      lastHealthyAt: '2026-08-13T00:00:00.000Z',
      lastError: null,
      skills: [{ taskType: 'hello', enabled: true }],
      notice: null,
    });
    api.fetchAiSwitches.mockResolvedValue(SNAPSHOT);
    api.fetchAiDailyCosts.mockResolvedValue(COSTS);
    api.fetchAiBudgetStatus.mockResolvedValue(STATUS);
    api.fetchAiCostBreakdown.mockResolvedValue(BREAKDOWN);
    api.setAiDailyBudget.mockResolvedValue(undefined);
    // 影子段缺省数据（boss 默认挂载即拉取）；技能版本空表
    api.fetchShadowIntent.mockResolvedValue(SHADOW_INTENT);
    api.fetchShadowDraft.mockResolvedValue(SHADOW_DRAFT);
    api.fetchSkillVersions.mockResolvedValue([]);
    api.harvestShadowExperience.mockResolvedValue({
      id: 'k1',
      kind: 'sales_method',
      status: 'draft',
      title: '影子样本·话术对比 9月2日',
      source: '影子样本回流·boss·2026-09-02',
    });
    // 运维卡（boss 默认挂载即拉取）：版本/备份状态缺省值
    systemMock.fetchHealthInfo.mockResolvedValue({
      status: 'ok',
      app: 'autofilm-store-ops',
      env: 'test',
      version: '0.2.0',
      buildTime: '2026-08-27T02:00:00.000Z',
      startedAt: '2026-08-27T02:00:00.000Z',
    });
    systemMock.backupStatus.mockResolvedValue({
      enabled: true,
      dir: '/pkg/backups',
      count: 3,
      latest: { file: 'autofilm-prod-x.dump', sizeBytes: 1024, mtime: '2026-08-27T01:00:00.000Z' },
    });
    systemMock.runBackup.mockResolvedValue({
      ok: true,
      file: 'b.dump',
      sizeBytes: 1,
      durationMs: 8000,
    });
    systemMock.diagnostics.mockResolvedValue({ version: { version: '0.2.0' } });
    msgbox.confirm.mockResolvedValue('confirm');
    msgbox.prompt.mockResolvedValue({ value: '20', action: 'confirm' });
  });

  it('渲染通道状态、开关列表（全局+每技能）与近 7 日成本（分→元）', async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).toContain('通道状态');
    expect(wrapper.text()).toContain('停止开关');
    expect(wrapper.text()).toContain('近 7 日成本');
    expect(wrapper.text()).toContain('技能 hello');

    const switches = switchesOf(wrapper);
    expect(switches).toHaveLength(2);
    expect(switches[0]?.props('modelValue')).toBe(true);

    // costFen=1234 → 12.34 元（toFixed(2)）
    expect(wrapper.text()).toContain('12.34');
  });

  it('关闭总开关：确认后 PUT（confirmed 由 api 层注入），成功刷新快照', async () => {
    api.setAiSwitch.mockResolvedValue({ ...SNAPSHOT, global: false });
    const wrapper = await mountView();

    await switchesOf(wrapper)[0]?.find('input').setValue(false);
    await flushPromises();

    expect(msgbox.confirm).toHaveBeenCalledWith(
      '确认要关闭「AI 总开关」吗？AI 任务将立即停止提交',
      '二次确认',
    );
    expect(api.setAiSwitch).toHaveBeenCalledWith({ scope: 'global', enabled: false });
    expect(message.success).toHaveBeenCalledWith('开关已更新');
    expect(switchesOf(wrapper)[0]?.props('modelValue')).toBe(false);
  });

  it('关闭技能开关：确认文案含技能名，taskType 随载荷提交', async () => {
    api.setAiSwitch.mockResolvedValue({
      ...SNAPSHOT,
      skills: [{ taskType: 'hello', enabled: false }],
    });
    const wrapper = await mountView();

    await switchesOf(wrapper)[1]?.find('input').setValue(false);
    await flushPromises();

    expect(msgbox.confirm).toHaveBeenCalledWith(
      '确认要关闭「技能 hello」吗？AI 任务将立即停止提交',
      '二次确认',
    );
    expect(api.setAiSwitch).toHaveBeenCalledWith({
      scope: 'skill',
      taskType: 'hello',
      enabled: false,
    });
  });

  it('确认弹窗取消：不发起切换请求，UI 保持原状', async () => {
    msgbox.confirm.mockRejectedValueOnce('cancel');
    const wrapper = await mountView();

    await switchesOf(wrapper)[0]?.find('input').setValue(false);
    await flushPromises();

    expect(api.setAiSwitch).not.toHaveBeenCalled();
    expect(switchesOf(wrapper)[0]?.props('modelValue')).toBe(true);
  });

  it('切换失败回滚 UI（乐观更新还原）', async () => {
    api.setAiSwitch.mockRejectedValueOnce(new Error('server 500'));
    const wrapper = await mountView();

    await switchesOf(wrapper)[0]?.find('input').setValue(false);
    await flushPromises();

    expect(api.setAiSwitch).toHaveBeenCalled();
    expect(switchesOf(wrapper)[0]?.props('modelValue')).toBe(true); // 回滚
  });

  it('system:manage-only 用户见开关不见成本（2026-08-13 分段门控）', async () => {
    const wrapper = await mountView({ permissions: ['system:manage'] });
    expect(wrapper.text()).toContain('停止开关');
    expect(wrapper.text()).not.toContain('近 7 日成本');
    expect(api.fetchAiDailyCosts).not.toHaveBeenCalled();
    expect(api.fetchAiBudgetStatus).not.toHaveBeenCalled();
    expect(api.fetchAiCostBreakdown).not.toHaveBeenCalled();
  });

  it('ai:cost:view-only 用户（boss）见通道状态与成本，不见开关、不请求开关快照', async () => {
    const wrapper = await mountView({ permissions: ['ai:cost:view'] });
    expect(wrapper.text()).toContain('通道状态');
    expect(wrapper.text()).toContain('近 7 日成本');
    expect(wrapper.text()).not.toContain('停止开关');
    expect(switchesOf(wrapper)).toHaveLength(0);
    expect(api.fetchAiSwitches).not.toHaveBeenCalled();
    expect(api.fetchAiDailyCosts).toHaveBeenCalled();
    expect(api.fetchAiBudgetStatus).toHaveBeenCalled();
    expect(api.fetchAiCostBreakdown).toHaveBeenCalled();
  });

  // —— Task 10：预算横幅（状态计算） ——

  it('预算横幅正常区间：绿色、已用/预算文案（分→元）、进度条百分比', async () => {
    const wrapper = await mountView();
    const alert = wrapper.findComponent(ElAlert);
    expect(alert.exists()).toBe(true);
    expect(alert.props('type')).toBe('success');
    expect(wrapper.text()).toContain('今日已用 50.00 元 / 预算 100.00 元');
    // 5000/10000×100 = 50
    expect(wrapper.findComponent(ElProgress).props('percentage')).toBe(50);
  });

  it('预算横幅达到 warn 线：橙色告警', async () => {
    api.fetchAiBudgetStatus.mockResolvedValueOnce({ ...STATUS, spentFen: 8500 });
    const wrapper = await mountView();
    expect(wrapper.findComponent(ElAlert).props('type')).toBe('warning');
    expect(wrapper.text()).toContain('今日已用 85.00 元');
  });

  it('预算横幅达到 alert 线：红色告警', async () => {
    api.fetchAiBudgetStatus.mockResolvedValueOnce({ ...STATUS, spentFen: 9600 });
    const wrapper = await mountView();
    expect(wrapper.findComponent(ElAlert).props('type')).toBe('error');
  });

  it('spent≥budget：横幅切换为「今日 AI 额度已满，新任务已暂停」', async () => {
    api.fetchAiBudgetStatus.mockResolvedValueOnce({ ...STATUS, spentFen: 10000 });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain('今日 AI 额度已满，新任务已暂停');
    expect(wrapper.findComponent(ElAlert).props('type')).toBe('error');
  });

  it('预算 0（AI 完全停用口径）：不渲染进度条，横幅显示额度已满', async () => {
    api.fetchAiBudgetStatus.mockResolvedValueOnce({
      ...STATUS,
      spentFen: 0,
      budgetFen: 0,
      warnFen: 0,
      alertFen: 0,
    });
    const wrapper = await mountView();
    expect(wrapper.findComponent(ElProgress).exists()).toBe(false);
    expect(wrapper.text()).toContain('今日 AI 额度已满，新任务已暂停');
  });

  // —— Task 10：临时提额 ——

  it('临时提额按钮仅 boss 角色可见（sys_admin 持 system:manage 亦不渲染，与后端 boss 硬校验对齐）', async () => {
    const boss = await mountView({ permissions: ['ai:cost:view'], roles: ['boss'] });
    expect(raiseButtonOf(boss)).toBeTruthy();

    // sys_admin 持有 system:manage 但非 boss：后端必 403，UI 不渲染入口
    const sysAdmin = await mountView({
      permissions: ['system:manage', 'ai:cost:view'],
      roles: ['sys_admin'],
    });
    expect(raiseButtonOf(sysAdmin)).toBeUndefined();

    const noRole = await mountView({ permissions: ['ai:cost:view'], roles: [] });
    expect(raiseButtonOf(noRole)).toBeUndefined();
  });

  it('临时提额：prompt 输入元 → ×100 转分提交 → 成功后刷新 status', async () => {
    msgbox.prompt.mockResolvedValueOnce({ value: '20', action: 'confirm' });
    const wrapper = await mountView();

    await raiseButtonOf(wrapper)?.trigger('click');
    await flushPromises();

    expect(msgbox.prompt).toHaveBeenCalledWith(
      '请输入新的当日预算（元，仅今日有效，次日自动回落）',
      '临时提额',
      expect.objectContaining({ inputPattern: expect.any(RegExp) }),
    );
    // 20 元 → 2000 分
    expect(api.setAiDailyBudget).toHaveBeenCalledWith(2000);
    // 首次挂载 1 次 + 提额成功后刷新 1 次
    expect(api.fetchAiBudgetStatus).toHaveBeenCalledTimes(2);
    expect(message.success).toHaveBeenCalledWith('当日预算已更新');
  });

  it('临时提额取消：不发起提额请求', async () => {
    msgbox.prompt.mockRejectedValueOnce('cancel');
    const wrapper = await mountView();

    await raiseButtonOf(wrapper)?.trigger('click');
    await flushPromises();

    expect(api.setAiDailyBudget).not.toHaveBeenCalled();
  });

  it('临时提额失败（如后端 403）：静默交给全局错误拦截，不刷新横幅', async () => {
    api.setAiDailyBudget.mockRejectedValueOnce(new Error('server 403'));
    const wrapper = await mountView();

    await raiseButtonOf(wrapper)?.trigger('click');
    await flushPromises();

    expect(api.setAiDailyBudget).toHaveBeenCalled();
    expect(api.fetchAiBudgetStatus).toHaveBeenCalledTimes(1); // 仅挂载时
    expect(message.success).not.toHaveBeenCalled();
  });

  // —— Task 10：成本分解 ——

  it('成本分解表：按 日期/模型/技能/任务数/token/成本(元) 渲染', async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).toContain('成本分解');
    expect(wrapper.text()).toContain('qwen-plus');
    expect(wrapper.text()).toContain('hello');
    // token 入/出合并展示
    expect(wrapper.text()).toContain('1000 / 500');
    // costFen=2345 → 23.45 元
    expect(wrapper.text()).toContain('23.45');
  });

  // —— Task 10 修复轮 1：部分失败不连带（Promise.allSettled 独立兜底） ——

  it('breakdown reject 时横幅与日报仍渲染（横幅可见性不绑定聚合查询健康度）', async () => {
    api.fetchAiCostBreakdown.mockRejectedValueOnce(new Error('server 500'));
    const wrapper = await mountView();
    // status 正常返回 → 横幅照常渲染、文案完整（Promise.all 口径下会整体跳过赋值）
    expect(wrapper.findComponent(ElAlert).exists()).toBe(true);
    expect(wrapper.text()).toContain('今日已用 50.00 元 / 预算 100.00 元');
    // 日报表同样不受影响（costFen=1234 → 12.34 元）
    expect(wrapper.text()).toContain('12.34');
  });

  // —— 系统运维（2026-08-26）：重启服务 boss 专属 ——

  it('系统运维卡仅 boss 角色渲染；确认后调重启端点并进入等待态', async () => {
    systemMock.restartServices.mockResolvedValue({ accepted: true, script: '/pkg/重启.command' });
    const boss = await mountView({ permissions: ['ai:cost:view'], roles: ['boss'] });
    expect(boss.text()).toContain('系统运维');

    const btn = boss.find('[data-testid="restart-services-btn"]');
    expect(btn.exists()).toBe(true);
    await btn.trigger('click');
    await flushPromises();

    expect(msgbox.confirm).toHaveBeenCalledWith(
      expect.stringContaining('确认重启'),
      '重启服务',
      expect.anything(),
    );
    expect(systemMock.restartServices).toHaveBeenCalledTimes(1);
    expect(boss.text()).toContain('正在提交重启请求');

    // sys_admin（system:manage 但非 boss）：不渲染入口（与后端硬校验对齐）
    const sysAdmin = await mountView({
      permissions: ['system:manage', 'ai:cost:view'],
      roles: ['sys_admin'],
    });
    expect(sysAdmin.find('[data-testid="restart-services-btn"]').exists()).toBe(false);
  });

  it('重启确认取消：不调重启端点', async () => {
    msgbox.confirm.mockRejectedValueOnce('cancel');
    const wrapper = await mountView();
    await wrapper.find('[data-testid="restart-services-btn"]').trigger('click');
    await flushPromises();
    expect(systemMock.restartServices).not.toHaveBeenCalled();
  });

  it('重启端点失败（403/脚本缺位）：退出等待态，交全局拦截器提示', async () => {
    systemMock.restartServices.mockRejectedValueOnce(new Error('403'));
    const wrapper = await mountView();
    await wrapper.find('[data-testid="restart-services-btn"]').trigger('click');
    await flushPromises();
    expect(systemMock.restartServices).toHaveBeenCalled();
    expect(wrapper.text()).not.toContain('正在提交重启请求');
  });

  // —— 2026-08-27 运维批次：版本标识 + 立即备份 + 诊断包 ——

  it('运维卡（boss）显示版本/构建时间/备份状态；立即备份与诊断包按钮可用', async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).toContain('v0.2.0');
    expect(wrapper.text()).toContain('已开启（每日 03:00）');
    expect(wrapper.text()).toContain('共 3 份');
    expect(systemMock.fetchHealthInfo).toHaveBeenCalled();
    expect(systemMock.backupStatus).toHaveBeenCalled();

    await wrapper.find('[data-testid="run-backup-btn"]').trigger('click');
    await flushPromises();
    expect(systemMock.runBackup).toHaveBeenCalledTimes(1);
    expect(message.success).toHaveBeenCalled();

    await wrapper.find('[data-testid="export-diagnostics-btn"]').trigger('click');
    await flushPromises();
    expect(systemMock.diagnostics).toHaveBeenCalledTimes(1);
    expect(systemMock.downloadDiagnostics).toHaveBeenCalledWith({ version: { version: '0.2.0' } });
  });

  it('备份失败：错误提示且状态可刷新；非 boss 不渲染运维卡（不请求版本/备份状态）', async () => {
    systemMock.runBackup.mockResolvedValueOnce({
      ok: false,
      file: null,
      sizeBytes: null,
      durationMs: 0,
      error: 'pg_dump 缺失',
    });
    const boss = await mountView();
    await boss.find('[data-testid="run-backup-btn"]').trigger('click');
    await flushPromises();
    expect(message.error).toHaveBeenCalledWith(expect.stringContaining('pg_dump 缺失'));

    const sysAdmin = await mountView({
      permissions: ['system:manage', 'ai:cost:view'],
      roles: ['sys_admin'],
    });
    expect(sysAdmin.find('[data-testid="run-backup-btn"]').exists()).toBe(false);
  });

  // —— 影子样本回流（阶段三 B2）：话术对比/照发候选/意向改判一键转经验卡 ——

  it('话术对比段：样本与照发候选渲染；照发候选按钮转卡（scope=draft + taskId）', async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).toContain('话术对比');
    expect(wrapper.text()).toContain('照发候选');
    expect(wrapper.text()).toContain('姐，本周到店贴膜送全车镀晶体验');
    // 照发率 0.5 → 50%
    expect(wrapper.text()).toContain('照发率 50%');

    await wrapper.find('[data-testid="harvest-verbatim-btn"]').trigger('click');
    await flushPromises();

    expect(api.harvestShadowExperience).toHaveBeenCalledWith({
      scope: 'draft',
      taskId: 't-verbatim',
    });
    expect(message.success).toHaveBeenCalledWith('已入知识库待老板审批');
  });

  it('话术对比样本行「转经验卡」：携带该样本 taskId', async () => {
    const wrapper = await mountView();
    await wrapper.find('[data-testid="harvest-draft-btn"]').trigger('click');
    await flushPromises();
    expect(api.harvestShadowExperience).toHaveBeenCalledWith({ scope: 'draft', taskId: 't-edit' });
  });

  it('意向改判样本行「转经验卡」：leadNo 展示 + scope=intent 三要素（含改判理由）', async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).toContain('L-SH-3');
    expect(wrapper.text()).toContain('客户已到店实车看膜');

    await wrapper.find('[data-testid="harvest-intent-btn"]').trigger('click');
    await flushPromises();

    expect(api.harvestShadowExperience).toHaveBeenCalledWith({
      scope: 'intent',
      leadId: 'l3',
      aiLevel: 'B',
      humanLevel: 'A',
      reason: '客户已到店实车看膜',
    });
    expect(message.success).toHaveBeenCalledWith('已入知识库待老板审批');
  });

  it('转卡失败（如 422 任务已删）：交全局拦截器提示，不弹成功', async () => {
    api.harvestShadowExperience.mockRejectedValueOnce(new Error('server 422'));
    const wrapper = await mountView();
    await wrapper.find('[data-testid="harvest-verbatim-btn"]').trigger('click');
    await flushPromises();
    expect(api.harvestShadowExperience).toHaveBeenCalled();
    expect(message.success).not.toHaveBeenCalledWith('已入知识库待老板审批');
  });

  it('无话术样本时：话术对比段渲染空态占位，不渲染转卡按钮', async () => {
    api.fetchShadowDraft.mockResolvedValueOnce({
      days: 30,
      total: 0,
      avgSimilarity: 1,
      verbatimRate: 1,
      samples: [],
      verbatimCandidates: [],
    });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain('暂无话术对比样本');
    expect(wrapper.find('[data-testid="harvest-draft-btn"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="harvest-verbatim-btn"]').exists()).toBe(false);
  });
});
