/** 同行内容数据（批次4 T1）：人工录入 + 爬虫自动填充共用一表；看板对比"同行 vs 我们"。 */
import type { Server } from 'node:http';

import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

const password = 'S3cure-Passw0rd!';

describe('同行内容数据（批次4 T1）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let bossToken = '';
  let salesToken = '';
  const ids: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const mk = async (role: string) => {
      const username = uniqueUsername('cpt');
      const user = await prisma.user.create({
        data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
      });
      const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username, password });
      return (res.body as { accessToken: string }).accessToken;
    };
    bossToken = await mk('boss');
    salesToken = await mk('sales_ops');
  });
  afterAll(async () => {
    await prisma.competitorPost.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  it('POST /marketing/competitor-posts：m02:edit 门禁（recorder 403 场景以 sales 可写为准），source 缺省 manual', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/marketing/competitor-posts')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({
        account: '本地XX贴膜',
        title: '全车膜 2999 限时活动',
        likesCount: 1520,
        commentsCount: 88,
        activityType: '优惠',
      })
      .expect(201);
    const row = res.body as { id: string; account: string; source: string };
    ids.push(row.id);
    expect(row.account).toBe('本地XX贴膜');
    expect(row.source).toBe('manual');
  });

  it('爬虫写入端点：crawler 源带 crawledAt，boss∪sys_admin 硬校验（sales 403）', async () => {
    const denied = await request(app.getHttpServer() as Server)
      .post('/api/v1/marketing/competitor-posts/crawler')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ items: [{ account: 'x', title: 'y' }] });
    expect(denied.status).toBe(403);
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/marketing/competitor-posts/crawler')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({
        items: [
          {
            account: '本地YY车衣',
            title: '奔驰 E 级完工案例',
            likesCount: 630,
            sharesCount: 12,
            publishedAt: new Date().toISOString(),
          },
        ],
      })
      .expect(201);
    const body = res.body as { upserted: number };
    expect(body.upserted).toBeGreaterThanOrEqual(1);
    const row = await prisma.competitorPost.findFirst({
      where: { account: '本地YY车衣' },
      orderBy: { createdAt: 'desc' },
    });
    if (row) ids.push(row.id);
    expect(row?.source).toBe('crawler');
    expect(row?.crawledAt).not.toBeNull();
  });

  it('GET 看板对比：/marketing/competitor-board 返回同行与我们的并排数据', async () => {
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/marketing/competitor-board')
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    const body = res.body as {
      competitors: Array<{ account: string; posts: number; totalLikes: number; topLikes: number }>;
      ours: { posts: number; totalLikes: number; topLikes: number };
    };
    expect(Array.isArray(body.competitors)).toBe(true);
    expect(body.ours).toHaveProperty('posts');
  });
});
