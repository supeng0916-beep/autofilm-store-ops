import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

/** 接管队列路由回归（2026-08-24）：GET /leads/takeover 是 /leads/:id 下的字面量路由，
 * 控制器注册顺序错误时会被参数路由吞掉返回 404「客资不存在」。 */
describe('接管队列（P4-05）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  let bossToken = '';

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const user = await prisma.user.create({
      data: {
        username: uniqueUsername('tk_boss'),
        passwordHash: await auth.hashPassword(password),
        displayName: 'tk-boss',
      },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'boss' } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username: user.username, password });
    bossToken = (res.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /leads/takeover 返回候选数组（不被 /leads/:id 参数路由吞掉）', async () => {
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/leads/takeover')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
