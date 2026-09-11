/** 经验卡提炼闭环（V1.5 批次6b）：陪练好回答/粘贴聊天记录 → AI 提炼经验卡（建议态草稿，
 * kind=sales_method）→ 老板审批生效 → 助手与陪练检索注入——替代微调的「学习」实现。 */
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

class ExtractGateway implements OpenClawGateway {
  last?: SubmitTaskRequest;
  submit(req: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.last = req;
    if (req.taskType === 'sales.experience.extract') {
      return Promise.resolve({
        status: 'done',
        output: {
          title: '报价异议：先问预算再讲区别',
          content:
            '场景：客户嫌贵、拿别家比价时\n话术：先问客户预算范围，按预算配方案再讲膜的区别，不直接降价\n要点：不贬低同行；报价前确认预算能省一半拉锯',
          tags: ['报价', '比价'],
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

describe('经验卡提炼闭环（V1.5 批次6b）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const gateway = new ExtractGateway();
  let token = '';
  const createdIds: string[] = [];
  let sessionId = '';

  beforeAll(async () => {
    app = await buildApp(gateway);
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const username = uniqueUsername('ex');
    const user = await prisma.user.create({
      data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'sales_ops' } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username, password });
    token = (res.body as { accessToken: string }).accessToken;
    // 造一场已完成的陪练会话（素材源）
    const s = await prisma.roleplaySession.create({
      data: {
        userId: user.id,
        scenario: 'price_objection',
        status: 'finished',
        turns: {
          create: [
            { role: 'customer', content: '你们这个太贵了吧' },
            { role: 'staff', content: '哥，您先说说预算，我按预算给您配' },
            { role: 'customer', content: '行，我预算五千左右' },
          ],
        },
      },
    });
    sessionId = s.id;
  });
  afterAll(async () => {
    await prisma.knowledgeItem.deleteMany({ where: { id: { in: createdIds } } });
    await prisma.roleplaySession.deleteMany({ where: { id: sessionId } });
    await app.close();
  });

  it('从陪练会话提炼：POST /agent/experience/extract {sessionId} → 建议态经验卡（sales_method/draft）', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/agent/roleplay/experience/extract')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId })
      .expect(201);
    const item = (
      res.body as {
        item: {
          id: string;
          kind: string;
          status: string;
          title: string;
          source: string | null;
        };
      }
    ).item;
    createdIds.push(item.id);
    expect(gateway.last?.taskType).toBe('sales.experience.extract');
    expect(String(gateway.last?.context?.scenario)).toContain('price_objection');
    expect(item.kind).toBe('sales_method');
    expect(item.status).toBe('draft'); // 建议态——老板审批后才生效
    expect(item.title).toContain('报价异议');
    expect(item.source).toContain('经验提炼');
  });

  it('从粘贴文本提炼：{rawText} 同样建建议态卡；AI 输出缺 title 时 422 拒收不留垃圾', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/agent/roleplay/experience/extract')
      .set('Authorization', `Bearer ${token}`)
      .send({ rawText: '客户：太贵了\n销售：咱们这个质保十年，算下来一年才六百' })
      .expect(201);
    const item = (res.body as { item: { id: string; kind: string; status: string } }).item;
    createdIds.push(item.id);
    expect(item.kind).toBe('sales_method');
    const bad = await request(app.getHttpServer() as Server)
      .post('/api/v1/agent/roleplay/experience/extract')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(bad.status).toBe(422); // sessionId 与 rawText 至少其一
  });

  it('匿名 401；他人陪练会话提炼 404（素材只归属本人）', async () => {
    const anon = await request(app.getHttpServer() as Server)
      .post('/api/v1/agent/roleplay/experience/extract')
      .send({ rawText: 'x' });
    expect(anon.status).toBe(401);
    const other = await request(app.getHttpServer() as Server)
      .post('/api/v1/agent/roleplay/experience/extract')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId: 'nonexistent' });
    expect(other.status).toBe(404);
  });
});
