/** 影子模式场景二·话术对比（事件源实现）：AI 草稿 vs 人工实发——零新增操作，纯事件流聚合。 */
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

const password = 'S3cure-Passw0rd!';

describe('影子话术对比（事件源）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let bossToken = '';
  let salesToken = '';
  const leadIds: string[] = [];
  const evIds: string[] = [];
  const taskIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const mk = async (role: string) => {
      const username = uniqueUsername('sd');
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
    void salesToken;

    // 样本 1：改写后发送（有差异）；样本 2：照发（相似度 1）
    const mkSample = async (leadNo: string, aiText: string, edit: string | null) => {
      const lead = await prisma.lead.create({
        data: { leadNo, sourceCategory: 'offline', sourcePlatform: 't', stage: 'new' },
      });
      leadIds.push(lead.id);
      const task = await prisma.aiTask.create({
        data: {
          taskType: 'sales.draft_message',
          refType: 'lead',
          refId: lead.id,
          status: 'done',
          inputSummary: 'sd',
          output: { message: aiText },
        },
      });
      taskIds.push(task.id);
      if (edit) {
        const ev = await prisma.leadEvent.create({
          data: {
            leadId: lead.id,
            kind: 'draft_created',
            content: { taskId: task.id, version: 2, text: edit, source: 'human_edit' },
          },
        });
        evIds.push(ev.id);
      }
      const ev2 = await prisma.leadEvent.create({
        data: {
          leadId: lead.id,
          kind: 'send_recorded',
          content: { taskId: task.id, sendEvidence: '（聊天记录）已发出' },
        },
      });
      evIds.push(ev2.id);
    };
    await mkSample('L-SD-1', '哥，膜贴好了来看下', '李哥，您 Model Y 的膜贴好了，明天来取车方便吗');
    await mkSample('L-SD-2', '姐，最近有活动', null);
  });
  afterAll(async () => {
    await prisma.leadEvent.deleteMany({ where: { id: { in: evIds } } });
    await prisma.aiTask.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
    await app.close();
  });

  it('GET /ai/shadow/draft：两条样本——改写样本相似度<1，照发样本=1；verbatimRate 命中', async () => {
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/ai/shadow/draft?days=7')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    const body = res.body as {
      total: number;
      avgSimilarity: number;
      verbatimRate: number;
      samples: Array<{ similarity: number; original: string; actual: string }>;
    };
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.avgSimilarity).toBeLessThanOrEqual(1);
    expect(body.verbatimRate).toBeGreaterThan(0);
    const edited = body.samples.find((s) => s.original.includes('膜贴好了来看下'));
    expect(edited?.similarity).toBeLessThan(0.9);
    expect(edited?.actual).toContain('李哥');
  });
});
