import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AiTaskRepository } from '../src/modules/ai-dispatch/ai-task.repository';
import { EmbeddingService } from '../src/modules/knowledge/embedding.service';
import { PrismaService } from '../src/prisma/prisma.service';

/** Embedding 用量计量（2026-08-28 P5 补遗）：知识库向量化直连 MiniMax，此前零计量——
 * 老板要求成本页含真实 embedding 消耗。embed() 成功后写 ai_tasks 行
 * （taskType=knowledge.embed，tokensIn=API 回传 total_tokens，2026-08-28 实测响应含该字段），
 * 成本按 ai-pricing 单价估算（embo-01 默认 ¥0.5/百万 = 50 分/百万）。 */

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function configStub(prices?: string): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => {
      if (key === 'WG_AI_MODEL_PRICES_FEN_PER_MTOK') return prices;
      // 测试环境不读开发 .env：embedding 配置给假值（fetch 已 stub，不产生真实调用）
      if (key === 'WG_EMBEDDING_API_URL') return process.env[key] ?? 'https://embedding.test/v1';
      if (key === 'WG_EMBEDDING_API_KEY') return process.env[key] ?? 'test-key';
      return process.env[key] ?? fallback;
    },
  } as unknown as ConfigService;
}

describe('EmbeddingService 用量计量（P5 补遗：知识库向量化计入 AI 成本）', () => {
  let prisma: PrismaService;
  let repo: AiTaskRepository;

  beforeAll(() => {
    prisma = new PrismaService(configStub());
    repo = new AiTaskRepository(prisma);
  });

  afterAll(async () => {
    await prisma.aiTask.deleteMany({ where: { taskType: 'knowledge.embed' } });
    await prisma.$disconnect();
  });

  /** 造服务：fetch stub 模拟 MiniMax 响应 */
  const makeService = (fetchMock: ReturnType<typeof vi.fn>, prices?: string) => {
    vi.stubGlobal('fetch', fetchMock);
    return new EmbeddingService(configStub(prices), repo);
  };

  it('成功调用 → 写 knowledge.embed 行：tokensIn=total_tokens、model=embo-01、成本按单价估算', async () => {
    const svc = makeService(
      vi
        .fn()
        .mockResolvedValue(
          okResponse({ vectors: [[0.1, 0.2]], total_tokens: 24, base_resp: { status_code: 0 } }),
        ),
    );
    try {
      const vectors = await svc.embed(['演示店门店知识库向量化计量探针'], 'db');
      expect(vectors).toEqual([[0.1, 0.2]]);

      const row = await prisma.aiTask.findFirstOrThrow({
        where: { taskType: 'knowledge.embed' },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.status).toBe('done');
      expect(row.tokensIn).toBe(24);
      expect(row.tokensOut).toBe(0);
      expect(row.model).toBe('embo-01');
      // 默认单价 50 分/百万：24 tokens = 0.0012 分 → 四舍五入 0（量级合理性见下一用例）
      expect(row.costEstimateFen).toBe(0);
      expect(JSON.parse(row.inputSummary)).toEqual({ type: 'db', texts: 1, chars: 15 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('大用量成本可观测：1 百万 tokens → 50 分（¥0.5，embo-01 官方价）', async () => {
    const svc = makeService(
      vi
        .fn()
        .mockResolvedValue(
          okResponse({ vectors: [[0.1]], total_tokens: 1_000_000, base_resp: { status_code: 0 } }),
        ),
    );
    try {
      await svc.embed(['x'.repeat(100)], 'query');
      const row = await prisma.aiTask.findFirstOrThrow({
        where: { taskType: 'knowledge.embed' },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.costEstimateFen).toBe(50);
      expect(JSON.parse(row.inputSummary)).toMatchObject({ type: 'query', texts: 1, chars: 100 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('响应无 total_tokens → 行仍建（任务数计入），token/成本如实留空', async () => {
    const svc = makeService(
      vi.fn().mockResolvedValue(okResponse({ vectors: [[0.1]], base_resp: { status_code: 0 } })),
    );
    try {
      await svc.embed(['文本'], 'db');
      const row = await prisma.aiTask.findFirstOrThrow({
        where: { taskType: 'knowledge.embed' },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.tokensIn).toBeNull();
      expect(row.costEstimateFen).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('计量写库失败不阻断向量化（尽力而为，只告警）', async () => {
    const createSpy = vi.fn().mockRejectedValue(new Error('db down'));
    const failingRepo = { create: createSpy } as unknown as AiTaskRepository;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          okResponse({ vectors: [[0.5]], total_tokens: 10, base_resp: { status_code: 0 } }),
        ),
    );
    try {
      const svc = new EmbeddingService(configStub(), failingRepo);
      const vectors = await svc.embed(['文本'], 'db');
      expect(vectors).toEqual([[0.5]]);
      expect(createSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('API 未配置 → 静默降级返回空向量且不产生计量行', async () => {
    const emptyConfig = {
      get: (key: string, fallback?: unknown) =>
        key === 'WG_EMBEDDING_API_URL' || key === 'WG_EMBEDDING_API_KEY'
          ? undefined
          : (process.env[key] ?? fallback),
    } as unknown as ConfigService;
    const createSpy = vi.fn();
    vi.stubGlobal('fetch', vi.fn());
    try {
      const svc = new EmbeddingService(emptyConfig, {
        create: createSpy,
      } as unknown as AiTaskRepository);
      const vectors = await svc.embed(['文本'], 'db');
      expect(vectors).toEqual([]);
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
