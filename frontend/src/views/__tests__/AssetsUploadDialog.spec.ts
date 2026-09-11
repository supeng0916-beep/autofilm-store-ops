import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { assetApi, type BatchUploadReport } from '../../api/asset';
import AssetsUploadDialog, { chunkAssetFiles } from '../AssetsUploadDialog.vue';

// 对话框只测分批与提交流：api 全量 mock，http 层不触达。
vi.mock('../../api/asset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/asset')>();
  return { ...actual, assetApi: { uploadBatch: vi.fn(), list: vi.fn() } };
});
const mockedUploadBatch = vi.mocked(assetApi.uploadBatch);

const MB = 1024 * 1024;
const makeFile = (name: string, sizeMB = 0.1): File =>
  new File([new Uint8Array(Math.round(sizeMB * MB))], name, { type: 'image/jpeg' });

const emptyReport = (): BatchUploadReport => ({ created: [], skippedDuplicate: [], failed: [] });

async function mountDialog() {
  const wrapper = mount(AssetsUploadDialog, {
    props: { modelValue: true },
    global: { plugins: [ElementPlus] },
  });
  await flushPromises();
  return wrapper;
}

describe('chunkAssetFiles 分批（T11 评审跟进项）', () => {
  it('按数量切分：12 个文件 → 5/5/2 三批', () => {
    const files = Array.from({ length: 12 }, (_, i) => makeFile(`f${i}.jpg`));
    const batches = chunkAssetFiles(files);
    expect(batches.map((b) => b.files.length)).toEqual([5, 5, 2]);
    // 文件顺序与归属不重不漏
    expect(batches.flatMap((b) => b.files.map((f) => f.name))).toEqual(files.map((f) => f.name));
  });

  it('按总大小切分：单批 ≤200MB（先到为准），totalBytes 精确累计', () => {
    const files = [makeFile('a.jpg', 150), makeFile('b.jpg', 100), makeFile('c.jpg', 100)];
    const batches = chunkAssetFiles(files);
    expect(batches.map((b) => b.files.map((f) => f.name))).toEqual([['a.jpg'], ['b.jpg', 'c.jpg']]);
    expect(batches[1].totalBytes).toBe(200 * MB);
  });

  it('单个超 200MB 文件独占一批不卡死；空输入返回空批次', () => {
    expect(chunkAssetFiles([makeFile('big.mp4', 300)])).toHaveLength(1);
    expect(chunkAssetFiles([])).toHaveLength(0);
  });
});

describe('AssetsUploadDialog 批量上传（v1.5 T14）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUploadBatch.mockResolvedValue(emptyReport());
  });

  it('7 个文件分 2 批串行提交：进度「第 X/Y 批」，uploadBatch 依批调用且串行', async () => {
    const wrapper = await mountDialog();
    const files = Array.from({ length: 7 }, (_, i) => makeFile(`f${i}.jpg`));
    (wrapper.vm as unknown as { chosenFiles: File[] }).chosenFiles = files;
    await flushPromises();

    // 第一批完成后才发第二批（串行）：用 mock 实现记录并发度
    let inFlight = 0;
    let maxInFlight = 0;
    mockedUploadBatch.mockImplementation(async (batchFiles: File[]) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return {
        created: batchFiles.map((f, i) => ({ id: `id-${i}`, title: f.name })),
        skippedDuplicate: [],
        failed: [],
      };
    });

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('上传'))!
      .trigger('click');
    await flushPromises();

    expect(mockedUploadBatch).toHaveBeenCalledTimes(2); // 7 = 5 + 2
    expect(mockedUploadBatch.mock.calls[0][0]).toHaveLength(5);
    expect(mockedUploadBatch.mock.calls[1][0]).toHaveLength(2);
    expect(maxInFlight).toBe(1); // 批间串行
    // 结果三段提示：新增 7、跳过 0、失败 0
    expect(wrapper.text()).toContain('新增 7');
    expect(wrapper.text()).toContain('跳过重复 0');
    expect(wrapper.text()).toContain('失败 0');
  });

  it('报告分三段展示：新增/跳过重复（列名）/失败（列名+原因）', async () => {
    mockedUploadBatch.mockResolvedValue({
      created: [{ id: 'a1', title: 'ok' }],
      skippedDuplicate: ['dup.jpg'],
      failed: [{ name: 'bad.txt', reason: '不支持的文件类型' }],
    });
    const wrapper = await mountDialog();
    (wrapper.vm as unknown as { chosenFiles: File[] }).chosenFiles = [makeFile('ok.jpg')];
    await flushPromises();

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('上传'))!
      .trigger('click');
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('新增 1');
    expect(text).toContain('dup.jpg');
    expect(text).toContain('bad.txt（不支持的文件类型）');
    // 第三参 carModel 未填为 undefined（2026-08-28 起批量通道可选携带车型）
    expect(mockedUploadBatch).toHaveBeenCalledWith(expect.any(Array), 'finished', undefined);
  });

  it('填写车型后每批上传都携带（2026-08-28 本批共用车型）', async () => {
    const wrapper = await mountDialog();
    (wrapper.vm as unknown as { chosenFiles: File[] }).chosenFiles = [
      makeFile('a.jpg'),
      makeFile('b.jpg'),
      makeFile('c.jpg'),
      makeFile('d.jpg'),
      makeFile('e.jpg'),
      makeFile('f.jpg'),
    ];
    (wrapper.vm as unknown as { carModel: string }).carModel = '问界M9';
    await flushPromises();

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('上传'))!
      .trigger('click');
    await flushPromises();

    expect(mockedUploadBatch).toHaveBeenCalledTimes(2); // 6 = 5 + 1
    expect(mockedUploadBatch.mock.calls[0][2]).toBe('问界M9');
    expect(mockedUploadBatch.mock.calls[1][2]).toBe('问界M9');
  });

  it('未选文件点上传：仅警告不发请求', async () => {
    const wrapper = await mountDialog();
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('上传'))!
      .trigger('click');
    await flushPromises();
    expect(mockedUploadBatch).not.toHaveBeenCalled();
  });
});
