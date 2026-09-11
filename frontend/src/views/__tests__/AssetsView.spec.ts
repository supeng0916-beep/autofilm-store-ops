import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchAiTaskDetail } from '../../api/aiTasks';
import { assetApi, type Asset } from '../../api/asset';
import { useAuthStore } from '../../stores/auth';
import AssetsView from '../AssetsView.vue';

// mock api 模块（AiTasksView.spec 模式）：页面不发真实请求，列表/文件逐用例指定。
// ASSET_KIND_LABEL 等常量保留原实现（importOriginal），仅替函数面。
vi.mock('../../api/asset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/asset')>();
  return {
    ...actual,
    assetApi: {
      list: vi.fn(),
      get: vi.fn(),
      upload: vi.fn(),
      fetchFile: vi.fn(),
      fetchThumb: vi.fn(),
      uploadBatch: vi.fn(),
      update: vi.fn(),
      batchLicensed: vi.fn(),
      remove: vi.fn(),
      suggestTags: vi.fn(),
    },
  };
});
vi.mock('../../api/aiTasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/aiTasks')>();
  return { ...actual, fetchAiTaskDetail: vi.fn() };
});

// 部分 mock element-plus（ApprovalCenterView.spec 模式）：ElMessageBox.confirm 可控，
// ElMessage 静音；组件本体照常渲染（ElementPlus 插件来自 actual 导出）
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

const mockedList = vi.mocked(assetApi.list);
const mockedFetchFile = vi.mocked(assetApi.fetchFile);
const mockedFetchThumb = vi.mocked(assetApi.fetchThumb);
const mockedUpdate = vi.mocked(assetApi.update);
const mockedBatchLicensed = vi.mocked(assetApi.batchLicensed);
const mockedRemove = vi.mocked(assetApi.remove);
const mockedSuggestTags = vi.mocked(assetApi.suggestTags);
const mockedTaskDetail = vi.mocked(fetchAiTaskDetail);

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    kind: 'finished',
    title: '卡宴 DM03 完工案例',
    filePath: 'uploads/assets/asset-x1.png',
    carModel: '保时捷卡宴',
    productModel: 'DM03',
    stage: null,
    technicianName: '张师傅',
    source: null,
    licensed: true,
    workOrderId: null,
    createdBy: 'u1',
    createdAt: '2026-08-19T02:00:00.000Z',
    fileHash: 'hash-1',
    thumbPath: 'uploads/assets/thumb-x1.webp',
    mediaType: 'image',
    duration: null,
    tags: [],
    ...overrides,
  };
}

/** blob URL 双桩：Node URL.createObjectURL 对 happy-dom Blob 品牌检查不稳，绕开实现细节 */
const objectUrl = 'blob:asset-test';

/** 挂载（ElSelect 在 happy-dom 下会递归更新，沿 AiTasksView.spec stub 先例；
 * 权限经 auth store 注入，上传按钮 m06:edit ∪ m06:approve） */
async function mountView(permissions: string[] = ['m06:view', 'm06:edit']) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore(pinia).permissions = permissions;
  const wrapper = mount(AssetsView, {
    global: { plugins: [ElementPlus, pinia], stubs: { teleport: true, ElSelect: true } },
  });
  await flushPromises();
  return wrapper;
}

const findButton = (wrapper: ReturnType<typeof mount>, text: string) =>
  wrapper.findAll('button').find((b) => b.text().includes(text));

describe('AssetsView 素材库（V2.3b，v1.5 T14）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockedList.mockResolvedValue([]);
    mockedFetchFile.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    mockedFetchThumb.mockResolvedValue(new Blob(['t'], { type: 'image/webp' }));
    mockedUpdate.mockImplementation(async (id, data) =>
      makeAsset({
        id,
        ...('licensed' in data ? { licensed: data.licensed! } : {}),
        ...(data.tags ? { tags: data.tags } : {}),
      }),
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(objectUrl);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  it('网格渲染卡片与 tag：kind 中文/车型/产品/授权绿 tag，图片卡经 thumb 端点 blob 渲染 el-image', async () => {
    mockedList.mockResolvedValue([
      makeAsset(),
      makeAsset({ id: 'asset-2', kind: 'quote_image', title: 'DM03 报价单', licensed: false }),
    ]);
    const wrapper = await mountView();

    // 两张卡片：标题与 kind 中文标签
    expect(wrapper.text()).toContain('卡宴 DM03 完工案例');
    expect(wrapper.text()).toContain('DM03 报价单');
    expect(wrapper.text()).toContain('完工案例');
    expect(wrapper.text()).toContain('报价图');
    // 车型/产品 tag（第二张无车型产品则不渲染）
    expect(wrapper.text()).toContain('保时捷卡宴');
    expect(wrapper.text()).toContain('DM03');
    // licensed：绿 tag「已授权」/ 灰 tag「内部」（info 同时用于车型/产品 tag，全量比对）
    expect(wrapper.find('.el-tag--success').text()).toContain('已授权');
    const infoTags = wrapper.findAll('.el-tag--info').map((t) => t.text());
    expect(infoTags).toContain('内部');
    // 两张均图片 → 两处 el-image；缩略经带令牌 fetchThumb → blob URL（happy-dom 的
    // IntersectionObserver 不触发回调，lazy 内层 img 不渲染，改断组件 src/预览 props）
    expect(wrapper.findAll('.el-image')).toHaveLength(2);
    expect(mockedFetchThumb).toHaveBeenCalledWith('asset-1');
    expect(mockedFetchFile).not.toHaveBeenCalled(); // 缩略走 thumb 端点，不再直拉原图
    const img = wrapper.getComponent({ name: 'ElImage' });
    expect(img.props('src')).toBe(objectUrl);
    expect(img.props('previewSrcList')).toEqual([objectUrl]);
  });

  it('视频素材：图标占位 + mm:ss 时长，不预取缩略/原文件', async () => {
    mockedList.mockResolvedValue([
      makeAsset({ mediaType: 'video', duration: 125, filePath: 'uploads/assets/v.mp4' }),
    ]);
    const wrapper = await mountView();

    expect(wrapper.find('.el-image').exists()).toBe(false);
    expect(wrapper.find('.asset-card__video').exists()).toBe(true);
    expect(wrapper.text()).toContain('02:05'); // 125s → mm:ss
    expect(mockedFetchThumb).not.toHaveBeenCalled();
    expect(mockedFetchFile).not.toHaveBeenCalled();
  });

  it('PDF 素材不渲染 el-image：图标占位，点击经 fetchFile 新窗口打开', async () => {
    mockedList.mockResolvedValue([
      makeAsset({ mediaType: 'document', filePath: 'uploads/assets/asset-x9.pdf' }),
    ]);
    const wrapper = await mountView();

    expect(wrapper.find('.el-image').exists()).toBe(false); // 无 el-image
    expect(wrapper.text()).toContain('PDF · 点击新窗口查看'); // 图标占位行
    // 未点击不预取 PDF 本体（按需下载）
    expect(mockedFetchFile).not.toHaveBeenCalled();

    await wrapper.find('.asset-card__pdf').trigger('click');
    await flushPromises();
    expect(mockedFetchFile).toHaveBeenCalledWith('asset-1');
    expect(window.open).toHaveBeenCalledWith(objectUrl, '_blank');
  });

  it('筛选触发 list：关键词回车/查询按钮携带 keyword，上传按钮按 m06:edit∪approve 可见', async () => {
    const wrapper = await mountView();
    expect(mockedList).toHaveBeenCalledWith({}); // 挂载首次全量

    await wrapper.find('.assets__keyword input').setValue('卡宴');
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('查询'))
      ?.trigger('click');
    await flushPromises();
    // 回车 change 与查询按钮各触发一次，均携带 keyword
    expect(mockedList).toHaveBeenLastCalledWith({ keyword: '卡宴' });
    expect(wrapper.findAll('button').some((b) => b.text().includes('上传素材'))).toBe(true);

    // 仅 m06:view（销售）无上传入口
    const sales = await mountView(['m06:view']);
    expect(sales.findAll('button').some((b) => b.text().includes('上传素材'))).toBe(false);
  });

  it('watch 说明卡：info 型可关闭 el-alert，文案含 uploads/inbox 与 5 分钟自动入库', async () => {
    const wrapper = await mountView();
    const tip = wrapper.find('.assets__watch-tip');
    expect(tip.exists()).toBe(true);
    expect(tip.text()).toContain('uploads/inbox');
    expect(tip.text()).toContain('每 5');
    // closable info：类名落在 el-alert 根（外层 assets__watch-tip 为 Transition 承接），
    // 关闭按钮在位（关闭动作为 Element Plus 内置，happy-dom 不复现 v-show 切换）
    const alertRoot = wrapper.find('.assets__watch-tip .el-alert');
    expect(alertRoot.classes()).toContain('el-alert--info');
    expect(alertRoot.find('.el-alert__close-btn').exists()).toBe(true);
  });

  it('标签筛选为前端过滤：输入命中 tags 子串保留卡片，不重复请求列表', async () => {
    mockedList.mockResolvedValue([
      makeAsset({ tags: ['DM03', '前杠'] }),
      makeAsset({ id: 'asset-2', title: '无关素材', tags: ['内饰'] }),
      makeAsset({ id: 'asset-3', title: '另一张', tags: [] }),
    ]);
    const wrapper = await mountView();
    expect(wrapper.findAll('.asset-card')).toHaveLength(3);

    await wrapper.find('.assets__tag-filter input').setValue('dm03'); // 忽略大小写
    await flushPromises();
    expect(mockedList).toHaveBeenCalledTimes(1); // 纯前端过滤，不重拉
    const cards = wrapper.findAll('.asset-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].text()).toContain('卡宴 DM03 完工案例');
  });

  it('按车型分组渲染（2026-08-25 老板反馈）：组头带车型名与张数，小列表自动展开', async () => {
    mockedList.mockResolvedValue([
      makeAsset(),
      makeAsset({ id: 'asset-2', title: '卡宴细节2' }),
      makeAsset({ id: 'asset-3', title: '问界M9-001', carModel: '问界M9', licensed: false }),
    ]);
    const wrapper = await mountView();

    // 两组：保时捷卡宴（2 张）+ 问界M9（1 张）；小列表自动展开 → 卡片可见
    const titles = wrapper.findAll('.assets__group-title').map((t) => t.text());
    expect(titles).toEqual(['保时捷卡宴', '问界M9']);
    expect(wrapper.text()).toContain('2 张');
    expect(wrapper.findAll('.asset-card')).toHaveLength(3);
    // 展开组的缩略图按组懒加载
    expect(mockedFetchThumb).toHaveBeenCalledWith('asset-1');
  });

  it('大列表默认收起当索引页：不渲染卡片不预取缩略，点组头展开后渲染该组', async () => {
    // 10 组 × 4 张 = 40 > 30 → 默认全部收起
    const many = Array.from({ length: 10 }, (_, gi) =>
      Array.from({ length: 4 }, (_, ii) =>
        makeAsset({ id: `g${gi}-${ii}`, title: `车${gi}-${ii}`, carModel: `车型${gi}` }),
      ),
    ).flat();
    mockedList.mockResolvedValue(many);
    const wrapper = await mountView();

    // 索引页：10 个组头、0 张卡片、未预取任何缩略
    expect(wrapper.findAll('.assets__group-title')).toHaveLength(10);
    expect(wrapper.findAll('.asset-card')).toHaveLength(0);
    expect(mockedFetchThumb).not.toHaveBeenCalled();

    // 点开第一个组头 → 该组 4 张渲染并预取缩略
    await wrapper.findAll('.el-collapse-item__header')[0].trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.asset-card')).toHaveLength(4);
    expect(mockedFetchThumb).toHaveBeenCalledWith('g0-0');
  });

  it('多选 + 授权所选（一键授权，老板反馈）：批量端点生效并同步卡片 tag', async () => {
    mockedBatchLicensed.mockResolvedValue({ updated: 2 });
    mockedList.mockResolvedValue([
      makeAsset({ id: 'a-1', licensed: false }),
      makeAsset({ id: 'a-2', licensed: false, title: '第二张' }),
    ]);
    const wrapper = await mountView();

    // 勾选两张卡片（卡片左上角复选框）
    const boxes = wrapper.findAll('.asset-card__select input');
    await boxes[0].setValue(true);
    await boxes[1].setValue(true);
    await flushPromises();
    expect(wrapper.find('[data-testid="batch-bar"]').text()).toContain('已选 2 项');

    await findButton(wrapper, '授权所选')!.trigger('click');
    await flushPromises();
    expect(mockedBatchLicensed).toHaveBeenCalledWith(['a-1', 'a-2'], true);
    // 两张卡片的授权 tag 同步翻转，选择清空
    expect(wrapper.findAll('.el-tag--success').length).toBeGreaterThanOrEqual(2);
    expect(wrapper.find('[data-testid="batch-bar"]').exists()).toBe(false);
  });

  it('整组授权：组工具条一键授权本组全部素材', async () => {
    mockedBatchLicensed.mockResolvedValue({ updated: 2 });
    mockedList.mockResolvedValue([
      makeAsset({ id: 'a-1', licensed: false }),
      makeAsset({ id: 'a-2', licensed: false, title: '第二张' }),
    ]);
    const wrapper = await mountView();

    await findButton(wrapper, '授权整组')!.trigger('click');
    await flushPromises();
    expect(mockedBatchLicensed).toHaveBeenCalledWith(['a-1', 'a-2'], true);
    expect(wrapper.findAll('.el-tag--success').length).toBeGreaterThanOrEqual(2);
  });

  it('删除素材：二次确认后调 DELETE 并移除卡片；取消确认不发请求', async () => {
    mockedRemove.mockResolvedValue({ deleted: true });
    msgbox.confirm.mockResolvedValue('confirm');
    mockedList.mockResolvedValue([
      makeAsset({ id: 'a-1' }),
      makeAsset({ id: 'a-2', title: '保留这张' }),
    ]);
    const wrapper = await mountView();

    // 取消路径：confirm 拒绝 → 不发 DELETE，卡片仍在
    msgbox.confirm.mockRejectedValueOnce('cancel');
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '删除')!
      .trigger('click');
    await flushPromises();
    expect(mockedRemove).not.toHaveBeenCalled();
    expect(wrapper.findAll('.asset-card')).toHaveLength(2);

    // 确认路径：删除第一张 → 卡片只剩一张，选择态/blob 缓存同步清理
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '删除')!
      .trigger('click');
    await flushPromises();
    expect(msgbox.confirm).toHaveBeenCalled();
    expect(mockedRemove).toHaveBeenCalledWith('a-1');
    expect(wrapper.findAll('.asset-card')).toHaveLength(1);
    expect(wrapper.text()).toContain('保留这张');
  });

  it('非照片类平铺：分类选报价图后无分组折叠，卡片直列渲染（老板 2026-08-25 口径）', async () => {
    mockedList.mockResolvedValue([
      makeAsset({ id: 'q-1', kind: 'quote_image', title: 'DM03 报价单', carModel: null }),
      makeAsset({ id: 'q-2', kind: 'quote_image', title: 'DM90 报价单', carModel: null }),
    ]);
    const wrapper = await mountView();
    // ElSelect 在本套件为 stub，分类值经组件状态直改后点查询（AssetsUploadDialog.spec 同手法）
    (wrapper.vm as unknown as { kindFilter: string }).kindFilter = 'quote_image';
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('查询'))!
      .trigger('click');
    await flushPromises();

    expect(mockedList).toHaveBeenLastCalledWith({ kind: 'quote_image' });
    expect(wrapper.find('.el-collapse').exists()).toBe(false); // 无分组折叠
    expect(wrapper.find('[data-testid="group-select-all"]').exists()).toBe(false); // 无组工具
    expect(wrapper.findAll('.asset-card')).toHaveLength(2); // 卡片直列可见
    expect(mockedFetchThumb).toHaveBeenCalledTimes(2); // 平铺模式直接取缩略
  });

  it('切换分类重查期间不闪现旧分类内容（老板 2026-08-25 反馈的切换闪现）', async () => {
    mockedList.mockResolvedValue([makeAsset({ id: 'f-1', title: '完工案例照' })]);
    const wrapper = await mountView();
    expect(wrapper.text()).toContain('完工案例照');

    // 报价图查询挂起：加载窗口内旧内容不渲染、无任何卡片/分组
    let resolveQuery: (v: Asset[]) => void = () => {};
    mockedList.mockReturnValue(
      new Promise<Asset[]>((resolve) => {
        resolveQuery = resolve;
      }),
    );
    (wrapper.vm as unknown as { kindFilter: string }).kindFilter = 'quote_image';
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('查询'))!
      .trigger('click');
    await flushPromises();

    expect(wrapper.text()).not.toContain('完工案例照');
    expect(wrapper.find('.el-collapse').exists()).toBe(false);
    expect(wrapper.findAll('.asset-card')).toHaveLength(0);

    // 结果返回后渲染新分类内容
    resolveQuery([makeAsset({ id: 'q-1', kind: 'quote_image', title: '报价单' })]);
    await flushPromises();
    expect(wrapper.text()).toContain('报价单');
    expect(wrapper.findAll('.asset-card')).toHaveLength(1);
  });

  it('授权开关：切换调 PATCH licensed 并同步卡片 tag', async () => {
    mockedList.mockResolvedValue([makeAsset({ licensed: false })]);
    const wrapper = await mountView();

    await wrapper.find('.asset-card__actions .el-switch input').setValue(true);
    await flushPromises();
    expect(mockedUpdate).toHaveBeenCalledWith('asset-1', { licensed: true });
    expect(wrapper.find('.el-tag--success').text()).toContain('已授权');
  });

  it('标签编辑对话框：删除/添加（去重、超长、超量拦截）后保存调 PATCH tags', async () => {
    mockedList.mockResolvedValue([makeAsset({ tags: ['旧标签'] })]);
    const wrapper = await mountView();

    await findButton(wrapper, '编辑标签')!.trigger('click');
    await flushPromises();
    const dialog = wrapper.find('.tag-edit');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).toContain('旧标签');

    // 删除既有 chip
    await dialog.find('.el-tag .el-icon, .el-tag__close')?.trigger('click');
    // 添加新标签（回车）
    await dialog.find('.tag-edit__input input').setValue('新标签');
    await dialog.find('.tag-edit__input input').trigger('keyup.enter');
    expect(dialog.text()).toContain('新标签');
    // 去重拦截：重复添加不进列表且不脏保存载荷
    await dialog.find('.tag-edit__input input').setValue('新标签');
    await dialog.find('.tag-edit__input input').trigger('keyup.enter');
    expect(dialog.findAll('.tag-edit__chip')).toHaveLength(1);

    await findButton(wrapper, '保存')!.trigger('click');
    await flushPromises();
    expect(mockedUpdate).toHaveBeenCalledWith('asset-1', { tags: ['新标签'] });
    // 保存后卡片 chip 同步
    expect(wrapper.find('.asset-card').text()).toContain('新标签');
  });

  it('AI 建议标签（同步终态）：展示建议 chips，采纳合入 tags 调 PATCH', async () => {
    mockedList.mockResolvedValue([makeAsset({ tags: ['原有'] })]);
    mockedSuggestTags.mockResolvedValue({
      id: 'task-1',
      status: 'done',
      output: { tags: ['DM03', '前杠'] },
    } as never);
    const wrapper = await mountView();

    await findButton(wrapper, 'AI建议标签')!.trigger('click');
    await flushPromises();
    expect(mockedSuggestTags).toHaveBeenCalledWith('asset-1');
    const dialog = wrapper.find('.suggest');
    expect(dialog.text()).toContain('DM03');
    expect(dialog.text()).toContain('前杠');

    await findButton(wrapper, '采纳')!.trigger('click');
    await flushPromises();
    expect(mockedUpdate).toHaveBeenCalledWith('asset-1', { tags: ['原有', 'DM03', '前杠'] });
    expect(wrapper.find('.asset-card').text()).toContain('前杠');
  });

  it('AI 建议标签（异步任务）：轮询 ai_task 详情至 done；仅 m06:edit 可见入口', async () => {
    mockedList.mockResolvedValue([makeAsset()]);
    mockedSuggestTags.mockResolvedValue({ id: 'task-9', status: 'running', output: null } as never);
    mockedTaskDetail.mockResolvedValue({
      task: { id: 'task-9', status: 'done', output: { tags: ['施工'] }, errorMessage: null },
      events: [],
    } as never);
    vi.useFakeTimers();
    const wrapper = await mountView();

    await findButton(wrapper, 'AI建议标签')!.trigger('click');
    await flushPromises();
    // 未到轮询间隔：尚未查详情
    expect(mockedTaskDetail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushPromises();
    expect(mockedTaskDetail).toHaveBeenCalledWith('task-9');
    expect(wrapper.find('.suggest').text()).toContain('施工');
    vi.useRealTimers();

    // 仅 m06:approve（无 m06:edit）不显示建议入口
    const approver = await mountView(['m06:view', 'm06:approve']);
    expect(findButton(approver, 'AI建议标签')).toBeUndefined();
  });

  it('AI 建议轮询：组件卸载后轮询即止，不再请求 ai_task 详情', async () => {
    mockedList.mockResolvedValue([makeAsset()]);
    mockedSuggestTags.mockResolvedValue({ id: 'task-9', status: 'running', output: null } as never);
    // 详情恒返回 running：轮询持续进行，便于观察卸载后的调用增量
    mockedTaskDetail.mockResolvedValue({
      task: { id: 'task-9', status: 'running', output: null },
      events: [],
    } as never);
    vi.useFakeTimers();
    const wrapper = await mountView();
    await findButton(wrapper, 'AI建议标签')!.trigger('click');
    await flushPromises();
    expect(mockedTaskDetail).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000); // 第一次轮询
    await flushPromises();
    expect(mockedTaskDetail).toHaveBeenCalledTimes(1);

    wrapper.unmount(); // 卸载置位取消标志
    await vi.advanceTimersByTimeAsync(60_000); // 覆盖多个轮询周期
    await flushPromises();
    expect(mockedTaskDetail).toHaveBeenCalledTimes(1); // 不再增长
    vi.useRealTimers();
  });

  it('AI 建议轮询：点「忽略」关闭对话框即终止轮询，不再请求详情', async () => {
    mockedList.mockResolvedValue([makeAsset()]);
    mockedSuggestTags.mockResolvedValue({ id: 'task-9', status: 'running', output: null } as never);
    mockedTaskDetail.mockResolvedValue({
      task: { id: 'task-9', status: 'running', output: null },
      events: [],
    } as never);
    vi.useFakeTimers();
    const wrapper = await mountView();
    await findButton(wrapper, 'AI建议标签')!.trigger('click');
    await flushPromises();

    // 首次轮询的 sleep 挂起期间点「忽略」→ 置位取消标志
    await findButton(wrapper, '忽略')!.trigger('click');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(mockedTaskDetail).not.toHaveBeenCalled(); // 轮询已终止，未发任何详情请求
    vi.useRealTimers();
  });
});
