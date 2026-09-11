import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AiTaskRepository } from '../src/modules/ai-dispatch/ai-task.repository';
import { EmbeddingService } from '../src/modules/knowledge/embedding.service';

/** 构造带指定环境变量的 EmbeddingService（不依赖真实配置）；
 * repo 为 no-op 桩——本套件只测向量请求/降级，计量落库由 embedding-usage.spec 覆盖 */
function makeService(env: Record<string, string>): EmbeddingService {
  const config = {
    get: (key: string, defaultValue?: string) => env[key] ?? defaultValue,
  } as unknown as ConfigService;
  const repo = { create: vi.fn().mockResolvedValue(undefined) } as unknown as AiTaskRepository;
  return new EmbeddingService(config, repo);
}

/** fetch 替身签名（仅覆盖服务用到的字段，Response 其余字段不涉及） */
type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** 成功响应（base_resp=0，返回给定向量） */
const okResponse = (vectors: number[][]) => ({
  ok: true,
  json: () =>
    Promise.resolve({
      vectors,
      base_resp: { status_code: 0, status_msg: 'success' },
    }),
});

const ENV: Record<string, string> = {
  WG_EMBEDDING_API_URL: 'https://api.minimaxi.com/v1/embeddings',
  WG_EMBEDDING_API_KEY: 'test-key',
};

describe('EmbeddingService（P4-02 MiniMax 国际平台格式）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('未配置 URL/KEY 时静默降级：返回空数组且不发起请求', async () => {
    const service = makeService({});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.embed(['文本'])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('请求体为国际平台格式：texts 数组 + type=db 默认 + Bearer 鉴权', async () => {
    const service = makeService(ENV);
    const fetchMock = vi.fn<FetchLike>();
    fetchMock.mockImplementation(() => Promise.resolve(okResponse([[0.1, 0.2]])));
    vi.stubGlobal('fetch', fetchMock);

    const out = await service.embed(['演示品牌DM10质保']);
    expect(out).toEqual([[0.1, 0.2]]);

    expect(fetchMock.mock.calls).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.minimaxi.com/v1/embeddings');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body)).toEqual({
      model: 'embo-01',
      texts: ['演示品牌DM10质保'],
      type: 'db',
    });
  });

  it('检索路径传 type=query', async () => {
    const service = makeService(ENV);
    const fetchMock = vi.fn<FetchLike>();
    fetchMock.mockImplementation(() => Promise.resolve(okResponse([[0.3]])));
    vi.stubGlobal('fetch', fetchMock);

    await service.embed(['DM10多少钱'], 'query');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as { type: string };
    expect(body.type).toBe('query');
  });

  it('base_resp 非 0（如 invalid api key）时静默降级返回空数组', async () => {
    const service = makeService(ENV);
    const fetchMock = vi.fn<FetchLike>();
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            base_resp: { status_code: 2049, status_msg: 'invalid api key' },
          }),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.embed(['文本'])).resolves.toEqual([]);
  });
});
