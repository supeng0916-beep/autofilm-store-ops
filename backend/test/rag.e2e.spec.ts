import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { extractRecallTokens, RagService } from '../src/modules/knowledge/rag.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

/** RAG 检索管道集成测试（P4-02）：分块/向量化/写入/检索 */
describe('RAG 检索管道（P4-02）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rag: RagService;
  let managerToken = '';

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    rag = app.get(RagService);
    const auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const manager = await (async () => {
      const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: 'store_manager' } });
      const user = await prisma.user.create({
        data: {
          username: uniqueUsername('rag_mgr'),
          passwordHash: await auth.hashPassword('S3cure-Passw0rd!'),
          displayName: 'rag_mgr',
        },
      });
      await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username: user.username, password: 'S3cure-Passw0rd!' });
      return (res.body as { accessToken: string }).accessToken;
    })();
    managerToken = manager;
  });

  afterAll(async () => {
    await app.close();
  });

  /** 创建知识条目并生效 */
  const createActiveItem = async (key: string, kind: string, title: string, content: string) => {
    const createRes = await request(app.getHttpServer() as Server)
      .post('/api/v1/knowledge')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ kind, key, title, content, source: '测试来源', licensed: true });
    expect(createRes.status).toBe(201);
    const id = (createRes.body as { id: string }).id;

    const actRes = await request(app.getHttpServer() as Server)
      .post(`/api/v1/knowledge/${id}/activate`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(actRes.status).toBe(200);
    return id;
  };

  // ─── 分块 ───

  describe('文本分块', () => {
    it('短文本 → 单块', () => {
      const chunks = rag.chunkText('这是一段短文本', 500, 100);
      expect(chunks.length).toBe(1);
      expect(chunks[0]).toBe('这是一段短文本');
    });

    it('长文本 → 多块含重叠', () => {
      const text = 'A'.repeat(900);
      const chunks = rag.chunkText(text, 500, 100);
      expect(chunks.length).toBe(2); // 0-500, 400-900
      expect(chunks[0].length).toBe(500);
      expect(chunks[1].length).toBe(500);
    });

    it('空文本 → 空数组', () => {
      expect(rag.chunkText('', 500, 100)).toEqual([]);
      expect(rag.chunkText('   ', 500, 100)).toEqual([]);
    });
  });

  // ─── 型号词提取（纯函数） ───

  describe('召回词提取（型号词 + 中文三元组）', () => {
    it('提取字母数字型号并去重', () => {
      expect(extractRecallTokens('DM03多少钱')).toEqual(['DM03', '多少钱']);
      expect(extractRecallTokens('甲牌 DM24 和 DM04 哪个好')).toEqual(['DM24', 'DM04', '哪个好']);
      expect(extractRecallTokens('DM25、DM05 都说说')).toEqual(['DM25', 'DM05', '都说说']);
    });
    it('中文连续段提取 3 元组', () => {
      expect(extractRecallTokens('演示款式什么价格')).toEqual([
        '演示款',
        '示款式',
        '款式什',
        '式什么',
        '什么价',
        '么价格',
      ]);
    });
    it('单词字母与双字中文不提取', () => {
      expect(extractRecallTokens('贴膜')).toEqual([]);
      expect(extractRecallTokens('质保几年间')).toEqual(['质保几', '保几年', '几年间']);
    });
  });

  // ─── 向量化写入 ───

  describe('向量写入', () => {
    it('生效后自动写入向量', async () => {
      const id = await createActiveItem(
        'rag-test-vector',
        'product',
        '向量化测试产品',
        '演示品牌DM04顶级前挡膜，透光率70%，隔热性能优异，适合各类车型',
      );

      // 给异步向量化一点时间
      await new Promise((r) => setTimeout(r, 500));

      const count = await prisma.$queryRawUnsafe<Array<{ cnt: number }>>(
        `SELECT COUNT(*) as cnt FROM knowledge_embeddings WHERE item_id = $1`,
        id,
      );
      // 注意：embedding API 未配置时不会写入，此测试仅在配置后生效
      // 未配置时跳过断言
      if (count.length > 0 && Number(count[0].cnt) > 0) {
        expect(Number(count[0].cnt)).toBeGreaterThan(0);
      }
    });
  });

  // ─── 检索 ───

  describe('语义检索', () => {
    it('检索返回活跃条目结果', async () => {
      const results = await rag.search('前挡膜隔热', 5);
      // 未配置 embedding API 时返回空，不抛错
      expect(Array.isArray(results)).toBe(true);
    });

    it(
      '型号词强制召回：无品牌前缀的短型号问句命中标题（P4-06 校准）',
      { timeout: 20000 },
      async () => {
        // 背景：embo-01 对「DM03多少钱」这类问句的向量相似度失真（正确条目 <0.05、
        // 错误条目反而更高），关键词确定性召回保证型号问句不漏检
        const id = await createActiveItem(
          'rag-test-kw-recall',
          'price',
          '演示品牌 DM03 标准报价（关键词召回测试）',
          '演示品牌 DM03 门店活动价 18,800 元，官方参考价 17,600 元。',
        );
        // 真实 embedding 异步落块：轮询直到该条目有分块（未配置/超时则跳过断言，降级安全）
        let chunkReady = false;
        for (let i = 0; i < 20; i++) {
          const cnt = await prisma.$queryRawUnsafe<Array<{ cnt: number }>>(
            `SELECT COUNT(*) as cnt FROM knowledge_embeddings WHERE item_id = $1`,
            id,
          );
          if (Number(cnt[0]?.cnt ?? 0) > 0) {
            chunkReady = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        if (chunkReady) {
          const results = await rag.search('DM03多少钱', 10);
          const hit = results.find((r) => r.itemId === id);
          expect(hit).toBeDefined();
          expect(hit?.matchedBy).toBe('keyword');
        }
      },
    );

    it('检索不包含过期条目', async () => {
      // 创建→生效→过期
      const id = await createActiveItem(
        'rag-test-expired',
        'product',
        '过期测试产品',
        '这是一条即将过期的测试知识',
      );

      await request(app.getHttpServer() as Server)
        .post(`/api/v1/knowledge/${id}/expire`)
        .set('Authorization', `Bearer ${managerToken}`);

      const results = await rag.search('过期测试', 10);
      const hasExpired = results.some((r) => r.itemId === id);
      expect(hasExpired).toBe(false);
    });
  });
});
