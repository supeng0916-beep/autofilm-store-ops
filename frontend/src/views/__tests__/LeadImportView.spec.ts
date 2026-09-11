import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus, { ElUpload } from 'element-plus';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import LeadImportView from '../LeadImportView.vue';

// mock api 模块：页面不发真实请求；下载走 blob（鉴权口径，裸链接已废弃）
const api = vi.hoisted(() => ({
  previewImport: vi.fn(),
  confirmImport: vi.fn(),
  importDispatch: vi.fn(),
  importKingsoft: vi.fn(),
  downloadTemplate: vi.fn(),
  downloadErrorExport: vi.fn(),
}));
vi.mock('../../api/leads', () => ({ leadsApi: api }));

// 部分 mock element-plus：ElMessage 可控，其余组件照常渲染（同 ApprovalCenterView.spec）
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

const PREVIEW = {
  previewToken: 'tok-1',
  rowCount: 3,
  errorRows: [
    { row: 2, message: '电话与微信均为空' },
    { row: 5, message: '微信格式错误' },
  ],
  warnings: [],
};
const RESULT = { batchId: 'b-1', created: 3, dupCount: 1, warnings: [] };

async function mountView() {
  const wrapper = mount(LeadImportView, { global: { plugins: [ElementPlus] } });
  await flushPromises();
  return wrapper;
}

/** 第一个 el-upload（Tab① CSV/Excel 导入）的 on-change 处理函数 */
function fileChangeHandler(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAllComponents(ElUpload)[0]?.props('onChange') as (file: { raw: File }) => void;
}

describe('LeadImportView 客资导入（P3-01 前端）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('预览含错误行时渲染错误表格', async () => {
    api.previewImport.mockResolvedValue(PREVIEW);
    const wrapper = await mountView();

    await fileChangeHandler(wrapper)({ raw: {} as File });
    await flushPromises();

    expect(api.previewImport).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('可导入 3 条');
    expect(wrapper.text()).toContain('电话与微信均为空');
    expect(wrapper.text()).toContain('微信格式错误');
  });

  it('确认导入后清空预览并显示结果', async () => {
    api.previewImport.mockResolvedValue(PREVIEW);
    api.confirmImport.mockResolvedValue(RESULT);
    const wrapper = await mountView();

    await fileChangeHandler(wrapper)({ raw: {} as File });
    await flushPromises();
    expect(wrapper.text()).toContain('确认导入');

    const confirmButton = wrapper.findAll('button').find((b) => b.text() === '确认导入');
    await confirmButton?.trigger('click');
    await flushPromises();

    expect(api.confirmImport).toHaveBeenCalledWith('tok-1');
    expect(wrapper.text()).not.toContain('确认导入'); // 预览已清空
    expect(wrapper.text()).toContain('批次 b-1');
    expect(wrapper.text()).toContain('入库 3 条');
  });

  it('派发 Tab 空文本不提交', async () => {
    const wrapper = await mountView();

    const submit = wrapper.findAll('button').find((b) => b.text() === '解析并入库');
    await submit?.trigger('click');
    await flushPromises();

    expect(api.importDispatch).not.toHaveBeenCalled();
  });

  it('预览失败时不重复弹错误 toast（由 http 拦截器统一弹出）', async () => {
    api.previewImport.mockRejectedValue(new Error('boom'));
    const wrapper = await mountView();

    await fileChangeHandler(wrapper)({ raw: {} as File });
    await flushPromises();

    expect(api.previewImport).toHaveBeenCalledTimes(1);
    expect(message.error).not.toHaveBeenCalled();
  });

  it('下载模板走鉴权 blob 下载（不再裸链接 401）', async () => {
    api.downloadTemplate.mockResolvedValue(
      new Blob(['xlsx'], { type: 'application/vnd.ms-excel' }),
    );
    // 只 spy 静态方法、不整替 URL 全局：整替后 happy-dom 锚点点击导航里
    // new URL(...) 崩成 unhandled rejection（时序相关，拖红整个门禁）
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:url-1');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const wrapper = await mountView();

    await wrapper.find('[data-test="download-template"]').trigger('click');
    await flushPromises();

    expect(api.downloadTemplate).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('导出错误行走鉴权 blob 下载（携带 previewToken）', async () => {
    api.previewImport.mockResolvedValue(PREVIEW);
    api.downloadErrorExport.mockResolvedValue(
      new Blob(['xlsx'], { type: 'application/vnd.ms-excel' }),
    );
    // 同上：只 spy 静态方法并拦下锚点点击，不整替 URL 全局
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:url-2');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const wrapper = await mountView();

    await fileChangeHandler(wrapper)({ raw: {} as File });
    await flushPromises();
    await wrapper.find('[data-test="export-errors"]').trigger('click');
    await flushPromises();

    expect(api.downloadErrorExport).toHaveBeenCalledWith('tok-1');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
