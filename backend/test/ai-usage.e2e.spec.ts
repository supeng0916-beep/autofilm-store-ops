/** AI 使用画像聚合（V1.5 批次3）：ai_tasks(refId=提交者) + ai_task_feedback → 按人/按技能/按日三维，
 * 纯确定性查询无新 AI；门禁 ai:cost:view（与成本同口径）。 */
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

class UsageGateway implements OpenClawGateway {
  submit(_req: SubmitTaskRequest): Promise<GatewayRunResult> {
    void _req;
    return Promise.resolve({ status: 'done', output: { reply: '（fake）' } });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve(void 0);
  }
}

interface UsageUserRow {
  userId: string;
  username: string;
  taskCount: number;
  doneCount: number;
  failCount: number;
  costFen: number;
  feedbackTotal: number;
  feedbackAdopted: number;
}

describe('AI 使用画像（V1.5 批次3）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let bossToken = '';
  let salesToken = '';
  let salesId = '';
  const createdTaskIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp(new UsageGateway());
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const mk = async (role: string) => {
      const username = uniqueUsername('us');
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
    salesId = sales.id;

    // 造数：sales 三条对话任务（2 done 1 failed）+ 1 条采用反馈；boss 一条系统任务
    for (const [status, cost] of [
      ['done', 12],
      ['done', 34],
      ['failed', 0],
    ] as const) {
      const t = await prisma.aiTask.create({
        data: {
          taskType: 'sales.agent.chat',
          refType: 'agent',
          refId: salesId,
          status,
          inputSummary: 'us',
          costEstimateFen: cost,
        },
      });
      createdTaskIds.push(t.id);
    }
    await prisma.aiTaskFeedback.create({
      data: { taskId: createdTaskIds[0], decision: 'adopted', userId: salesId },
    });

    const bt = await prisma.aiTask.create({
      data: {
        taskType: 'boss.morning_brief',
        refType: 'system',
        refId: 'boss-brief-test',
        status: 'done',
        inputSummary: 'us',
        costEstimateFen: 5,
      },
    });
    createdTaskIds.push(bt.id);
  });
  afterAll(async () => {
    await prisma.aiTaskFeedback.deleteMany({ where: { taskId: { in: createdTaskIds } } });
    await prisma.aiTask.deleteMany({ where: { id: { in: createdTaskIds } } });
    await app.close();
  });

  it('GET /ai/usage/summary：ai:cost:view 门禁——sales 403、boss 200', async () => {
    const denied = await request(app.getHttpServer() as Server)
      .get('/api/v1/ai/usage/summary')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(denied.status).toBe(403);
    const ok = await request(app.getHttpServer() as Server)
      .get('/api/v1/ai/usage/summary?days=7')
      .set('Authorization', `Bearer ${bossToken}`);
    expect(ok.status).toBe(200);
  });

  it('按人聚合：任务数/成败/成本/反馈采纳', async () => {
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/ai/usage/summary?days=7')
      .set('Authorization', `Bearer ${bossToken}`);
    const body = res.body as { byUser: UsageUserRow[] };
    const byUser = body.byUser ?? [];

    const mine = byUser.find((row) => row.userId === salesId);

    expect(mine).toMatchObject({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- 本文件类型推断异常
      username: expect.stringContaining('us'),
      taskCount: 3,
      doneCount: 2,
      failCount: 1,
      costFen: 46,
      feedbackTotal: 1,
      feedbackAdopted: 1,
    });
  });

  it('按技能与按日聚合：taskType 计数正确、byDay 覆盖今天', async () => {
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/ai/usage/summary?days=7')
      .set('Authorization', `Bearer ${bossToken}`);
    const body = res.body as {
      byTaskType: Array<{ taskType: string; count: number; costFen: number }>;
      byDay: Array<{ date: string; count: number }>;
      total: { taskCount: number; costFen: number };
    };
    const chat = body.byTaskType.find((t) => t.taskType === 'sales.agent.chat');
    expect(chat?.count).toBeGreaterThanOrEqual(3);
    const brief = body.byTaskType.find((t) => t.taskType === 'boss.morning_brief');
    expect(brief?.count).toBeGreaterThanOrEqual(1);
    expect(body.byDay.length).toBeGreaterThan(0);
    expect(body.total.taskCount).toBeGreaterThanOrEqual(4);
  });
});
