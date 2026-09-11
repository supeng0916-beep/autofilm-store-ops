/** persona 端点（V1.5 Task2）：/agent/persona 登录即可自查；/agent/persona-map 仅 system:manage，
 * PUT 单条 set/del + 审计；无权限 403（fail-closed）。 */
import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

const password = 'S3cure-Passw0rd!';

describe('persona 端点（V1.5）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let bossToken = '';
  let salesToken = '';
  let targetUserId = '';

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const mk = async (role: string) => {
      const username = uniqueUsername('pe');
      const user = await prisma.user.create({
        data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
      });
      const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username, password });
      return { token: (res.body as { accessToken: string }).accessToken, id: user.id };
    };
    const boss = await mk('boss');
    bossToken = boss.token;
    const sales = await mk('sales_ops');
    salesToken = sales.token;
    targetUserId = sales.id;
  });
  afterAll(async () => {
    await prisma.systemMeta.deleteMany({ where: { key: 'agent.persona.map' } });
    await app.close();
  });

  it('GET /agent/persona：登录自查返回 persona+displayName，匿名 401', async () => {
    const anon = await request(app.getHttpServer() as Server).get('/api/v1/agent/persona');
    expect(anon.status).toBe(401);
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/agent/persona')
      .set('Authorization', `Bearer ${bossToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ persona: 'boss', displayName: '老板助手' });
  });

  it('GET/PUT /agent/persona-map：system:manage 门禁——sales 403、boss 200，写入生效', async () => {
    const denied = await request(app.getHttpServer() as Server)
      .get('/api/v1/agent/persona-map')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(denied.status).toBe(403);
    const ok = await request(app.getHttpServer() as Server)
      .get('/api/v1/agent/persona-map')
      .set('Authorization', `Bearer ${bossToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty('entries');
    expect(ok.body).toHaveProperty('unmappedMultiRole');

    const put = await request(app.getHttpServer() as Server)
      .put('/api/v1/agent/persona-map')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ userId: targetUserId, persona: 'manager' });
    expect(put.status).toBe(200);
    // 写入生效：sales 自查变店长包
    const self = await request(app.getHttpServer() as Server)
      .get('/api/v1/agent/persona')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(self.body).toEqual({ persona: 'manager', displayName: '店长助手' });
    // 非法 persona 400（zod 校验）
    const bad = await request(app.getHttpServer() as Server)
      .put('/api/v1/agent/persona-map')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ userId: targetUserId, persona: 'keeper' });
    expect(bad.status).toBe(400);
  });
});
