import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

/** 知识检索集成测试（P4-03）：POST /api/v1/knowledge/search */
describe('知识检索（P4-03）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let managerToken = '';

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    const auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const manager = await (async () => {
      const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: 'store_manager' } });
      const user = await prisma.user.create({
        data: {
          username: uniqueUsername('ks_mgr'),
          passwordHash: await auth.hashPassword('S3cure-Passw0rd!'),
          displayName: 'ks_mgr',
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
  const createActiveItem = async (
    key: string,
    kind: string,
    title: string,
    content: string,
    licensed = true,
  ) => {
    const createRes = await request(app.getHttpServer() as Server)
      .post('/api/v1/knowledge')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ kind, key, title, content, source: '测试来源', licensed });
    expect(createRes.status).toBe(201);
    const id = (createRes.body as { id: string }).id;

    const actRes = await request(app.getHttpServer() as Server)
      .post(`/api/v1/knowledge/${id}/activate`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(actRes.status).toBe(200);
    return id;
  };

  // ─── 检索基本功能 ───

  describe('检索', () => {
    it('知识库为空时返回"无法确定"', async () => {
      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/knowledge/search')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ query: 'DM04多少钱' });
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.answer).toBe('无法确定，需人工核实');
      expect(body.confidence).toBe('uncertain');
    });

    it('存在相关条目时返回检索结果', async () => {
      await createActiveItem(
        'search-test-dm04',
        'product',
        '演示品牌 DM04',
        '演示品牌DM04是顶级前挡膜，透光率70%，隔热性能优异，适合各类车型',
      );

      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/knowledge/search')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ query: '前挡膜隔热' });
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.answer).toBeTruthy();
      expect(Array.isArray(body.results)).toBe(true);
      // 检索结果带 itemId（首页助手「查看原文」依赖，2026-08-19 增补）
      const results = body.results as Array<{ itemId?: string }>;
      expect(results[0]?.itemId).toBeTruthy();
    });

    it('未授权素材不出现在检索结果中', async () => {
      await createActiveItem(
        'search-test-unlicensed',
        'product',
        '未授权产品',
        '这是一条未授权的测试知识',
        false,
      );

      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/knowledge/search')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ query: '未授权产品' });
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      const results = body.results as Array<Record<string, unknown>>;
      const hasUnlicensed = results.some((r) => r.licensed === false);
      expect(hasUnlicensed).toBe(false);
    });

    it('过期条目不出现在检索结果中', async () => {
      const id = await createActiveItem(
        'search-test-expired',
        'product',
        '过期产品',
        '这是一条已过期的测试知识',
      );

      await request(app.getHttpServer() as Server)
        .post(`/api/v1/knowledge/${id}/expire`)
        .set('Authorization', `Bearer ${managerToken}`);

      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/knowledge/search')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ query: '过期产品' });
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.answer).toBe('无法确定，需人工核实');
    });

    it('空查询被拒绝', async () => {
      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/knowledge/search')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ query: '' });
      expect([400, 422]).toContain(res.status);
    });

    it('V2.3b 响应含 assets 确定性匹配数组，且仅 licensed 素材可被引用', async () => {
      const tag = Math.random().toString(36).slice(2, 8);
      const licensedAsset = await prisma.asset.create({
        data: {
          kind: 'finished',
          title: `卡宴完工案例${tag}`,
          filePath: `uploads/assets/asset-${tag}-t1.png`,
          carModel: 'Cayenne',
          licensed: true,
          createdBy: 'ks-spec',
        },
      });
      // 同 tag 的未授权素材：分词会同时命中，licensed 语义应将其排除
      const unlicensed = await prisma.asset.create({
        data: {
          kind: 'quote_image',
          title: `未授权报价图${tag}`,
          filePath: `uploads/assets/asset-${tag}-t2.png`,
          licensed: false,
          createdBy: 'ks-spec',
        },
      });

      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/knowledge/search')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ query: `卡宴完工案例${tag}` });
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(Array.isArray(body.assets)).toBe(true);
      const assets = body.assets as Array<{
        id: string;
        title: string;
        kind: string;
        carModel: string | null;
        licensed: boolean;
      }>;
      const ids = assets.map((a) => a.id);
      expect(ids).toContain(licensedAsset.id);
      expect(ids).not.toContain(unlicensed.id);
      const hit = assets.find((a) => a.id === licensedAsset.id)!;
      expect(hit.title).toBe(`卡宴完工案例${tag}`);
      expect(hit.kind).toBe('finished');
      expect(hit.carModel).toBe('Cayenne');
      expect(hit.licensed).toBe(true);

      await prisma.asset.deleteMany({ where: { title: { contains: tag } } });
    });
  });
});
