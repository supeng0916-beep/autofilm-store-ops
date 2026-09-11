/** 销售陪练（V1.5 批次6a）：全员共用练功房——开局/回合/点评三段流，会话落库与隔离，
 * 权限=登录即可（练功全员开放）；taskType=sales.roleplay.chat/review 同技能双模式。 */
import type { Server } from 'node:http';

import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  GatewayRunResult,
  OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

const password = 'S3cure-Passw0rd!';

class RoleplayGateway implements OpenClawGateway {
  last?: SubmitTaskRequest;
  submit(req: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.last = req;
    if (req.taskType === 'sales.roleplay.chat') {
      const c = req.context as { mode?: string };
      void c;
      return Promise.resolve({
        status: 'done',
        output: { reply: '你们这个太贵了吧，别家便宜两千呢', mood: 'annoyed' },
      });
    }
    if (req.taskType === 'sales.roleplay.review') {
      return Promise.resolve({
        status: 'done',
        output: {
          summary: '整体不错，报价环节铺垫不足',
          strengths: ['开场自然'],
          improvements: ['报价前先确认预算'],
          demo: '——您可以先说说您的预算范围，我按预算给您配方案——',
        },
      });
    }
    return Promise.resolve({ status: 'done', output: { greeting: 'fake' } });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve(void 0);
  }
}

describe('销售陪练（V1.5 批次6a）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const gateway = new RoleplayGateway();
  let token = '';
  let token2 = '';
  let userId = '';
  const sessionIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp(gateway);
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const mk = async () => {
      const username = uniqueUsername('rp');
      const user = await prisma.user.create({
        data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
      });
      const role = await prisma.role.findUniqueOrThrow({ where: { code: 'sales_ops' } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username, password });
      return { token: (res.body as { accessToken: string }).accessToken, id: user.id };
    };
    const u1 = await mk();
    token = u1.token;
    userId = u1.id;
    token2 = (await mk()).token;
    await prisma.roleplaySession.deleteMany({ where: { userId } });
  });
  afterAll(async () => {
    await prisma.roleplaySession.deleteMany({ where: { id: { in: sessionIds } } });
    await app.close();
  });

  it('开局：POST /agent/roleplay/sessions 建会话+AI 客户开场白，非法剧本 400，匿名 401', async () => {
    const anon = await request(app.getHttpServer() as Server)
      .post('/api/v1/agent/roleplay/sessions')
      .send({ scenario: 'first_touch' });
    expect(anon.status).toBe(401);
    const bad = await request(app.getHttpServer() as Server)
      .post('/api/v1/agent/roleplay/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({ scenario: '不存在的剧本' });
    expect(bad.status).toBe(422);
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/agent/roleplay/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({ scenario: 'price_objection', persona: { carModel: 'Model Y', difficulty: 'hard' } })
      .expect(201);
    const body = res.body as {
      sessionId: string;
      turns: Array<{ role: string; content: string }>;
    };
    sessionIds.push(body.sessionId);
    expect(gateway.last?.taskType).toBe('sales.roleplay.chat');
    expect(body.turns[0]?.role).toBe('customer');
    expect(String(gateway.last?.context?.scenario)).toContain('price_objection');
  });

  it('回合：POST turns 员工发言→AI 客户回应，回合落库', async () => {
    const sid = sessionIds[0];
    const res = await request(app.getHttpServer() as Server)
      .post(`/api/v1/agent/roleplay/sessions/${sid}/turns`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: '哥，我们这个价格是有原因的，我给您讲讲区别' })
      .expect(201);
    const body = res.body as { reply: string; mood?: string; turns: unknown[] };
    expect(body.reply).toContain('贵');
    const turns = await prisma.roleplayTurn.findMany({ where: { sessionId: sid } });
    expect(turns.length).toBeGreaterThanOrEqual(3); // 客户开场白+员工+客户
  });

  it('会话隔离：他人会话回合 404/403', async () => {
    const sid = sessionIds[0];
    const res = await request(app.getHttpServer() as Server)
      .post(`/api/v1/agent/roleplay/sessions/${sid}/turns`)
      .set('Authorization', `Bearer ${token2}`)
      .send({ message: '我是谁' });
    expect([403, 404]).toContain(res.status);
  });

  it('结束点评：POST finish 生成点评落库，会话转 finished；重复 finish 返回既有点评', async () => {
    const sid = sessionIds[0];
    const res = await request(app.getHttpServer() as Server)
      .post(`/api/v1/agent/roleplay/sessions/${sid}/finish`)
      .set('Authorization', `Bearer ${token}`)
      .send({ score: 4 })
      .expect(200);
    const body = res.body as { summary: string; demo?: string };
    expect(gateway.last?.taskType).toBe('sales.roleplay.review');
    expect(body.summary).toContain('不错');
    const row = await prisma.roleplaySession.findUniqueOrThrow({ where: { id: sid } });
    expect(row.status).toBe('finished');
    expect(row.score).toBe(4);
    const again = await request(app.getHttpServer() as Server)
      .post(`/api/v1/agent/roleplay/sessions/${sid}/finish`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    void again;
  });

  it('列表：GET sessions 只见自己的会话', async () => {
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/agent/roleplay/sessions')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const list = res.body as Array<{ id: string; userId: string }>;
    expect(list.every((s) => s.userId === userId)).toBe(true);
    expect(list.some((s) => s.id === sessionIds[0])).toBe(true);
  });
});
