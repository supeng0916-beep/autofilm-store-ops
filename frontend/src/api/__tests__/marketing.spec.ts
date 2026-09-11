import { beforeEach, describe, expect, it, vi } from 'vitest';

import { inspirationApi } from '../marketing';
import { http } from '../http';

// 整模块 mock http 实例：只断言路径/载荷/超时契约，不发真实请求（沿 api/__tests__/aftercare.spec 手法）
vi.mock('../http', () => ({
  http: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

describe('api/marketing inspirationApi 请求契约（M02 批次B Task 3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('list：GET /marketing/video/inspirations，空筛选项不进 query', async () => {
    vi.mocked(http.get).mockResolvedValue({ data: [] });
    await inspirationApi.list();
    expect(http.get).toHaveBeenCalledWith('/marketing/video/inspirations', { params: {} });
  });

  it('list：keyword/platform/isPeer 逐项透传（isPeer 仅在显式给定时不省略）', async () => {
    vi.mocked(http.get).mockResolvedValue({ data: [] });
    await inspirationApi.list({ keyword: '避坑', platform: '抖音', isPeer: true });
    expect(http.get).toHaveBeenCalledWith('/marketing/video/inspirations', {
      params: { keyword: '避坑', platform: '抖音', isPeer: true },
    });
  });

  it('create：POST 必填四要素 + 可选项，可选空值不透传', async () => {
    vi.mocked(http.post).mockResolvedValue({ data: {} });
    await inspirationApi.create({
      platform: '抖音',
      title: '贴膜避坑',
      hookText: '前 3 秒抛痛点',
      structure: '痛点→案例→做法',
      tags: ['避坑'],
      isPeer: true,
    });
    expect(http.post).toHaveBeenCalledWith(
      '/marketing/video/inspirations',
      expect.objectContaining({
        platform: '抖音',
        title: '贴膜避坑',
        hookText: '前 3 秒抛痛点',
        structure: '痛点→案例→做法',
        tags: ['避坑'],
        isPeer: true,
      }),
    );
    const body = vi.mocked(http.post).mock.calls[0]![1] as Record<string, unknown>;
    expect(body['rhythm']).toBeUndefined();
    expect(body['metrics']).toBeUndefined();
    expect(body['sourceUrl']).toBeUndefined();
    expect(body['note']).toBeUndefined();
  });

  it('update：PATCH /marketing/video/inspirations/:id（note/tags/status）', async () => {
    vi.mocked(http.patch).mockResolvedValue({ data: {} });
    await inspirationApi.update('ins-1', { status: 'archived', tags: ['科普'] });
    expect(http.patch).toHaveBeenCalledWith('/marketing/video/inspirations/ins-1', {
      status: 'archived',
      tags: ['科普'],
    });
  });

  it('dissect：POST dissect 载荷对齐（rawText/platform/isPeer），超时 180s', async () => {
    vi.mocked(http.post).mockResolvedValue({
      data: {
        taskId: 't1',
        dissect: { hookText: '', structure: '', rhythm: null, tags: [], takeaway: '' },
      },
    });
    await inspirationApi.dissect({ rawText: '一条足够长的爆款原文', platform: '抖音' });
    expect(http.post).toHaveBeenCalledWith(
      '/marketing/video/inspirations/dissect',
      { rawText: '一条足够长的爆款原文', platform: '抖音' },
      { timeout: 180_000 },
    );
  });

  it('scan：POST scan 携带空请求体 {}（无参 POST 显式空体，沿 aftercare 先例），超时 240s', async () => {
    vi.mocked(http.post).mockResolvedValue({ data: { taskId: 't2', items: [], scanNote: null } });
    await inspirationApi.scan();
    expect(http.post).toHaveBeenCalledWith(
      '/marketing/video/inspirations/scan',
      {},
      { timeout: 240_000 },
    );
  });
});
