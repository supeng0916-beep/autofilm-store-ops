import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import { AiCallbackService } from '../src/modules/ai-dispatch/ai-callback.service';
import { AiHealthService } from '../src/modules/ai-dispatch/ai-health.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

/** 控制台任务行（只断言用到的字段） */
interface AiTaskRow {
  id: string;
  taskType: string;
  refType: string | null;
  refId: string | null;
  status: string;
  inputSummary: string;
}

/** 事件行（时间线） */
interface EventRow {
  taskId: string;
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  createdAt: string;
}

/** 通知行 */
interface NotificationRow {
  userId: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  sourceType: string | null;
  sourceId: string | null;
}

/** Agent 任务控制台（V2.2b Task1-3）：只读端点 + 重试/接管 + 降级/失败通知接线。
 * 隔离：全部造数带随机 tag（inputSummary 内），断言按 tag/id 定位，不碰全库计数；
 * 通知断言限定 userId+sourceId（本运行创建的任务 id）。 */
describe('AI 任务控制台（V2.2b）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  const tag = Math.random().toString(36).slice(2, 8);
  let bossToken = '';
  let bossId = '';
  let sysadminToken = '';
  let sysadminId = '';
  let salesToken = '';
  /** 本运行创建的任务 id 清单：afterAll 定点清理。
   * 注意不能只靠 inputSummary 含 tag 定位——活链路（hello/retry）会经 maskDeep 脱敏改写，tag 不保留。 */
  const mineIds: string[] = [];

  const mkUser = async (uname: string, role: string): Promise<{ token: string; id: string }> => {
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
    const user = await prisma.user.create({
      data: {
        username: uname,
        passwordHash: await auth.hashPassword(password),
        displayName: uname,
      },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username: uname, password });
    // 登录为创建动作（POST /auth/login → 201），非查询语义
    expect(res.status).toBe(201);
    return { token: (res.body as { accessToken: string }).accessToken, id: user.id };
  };

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'sys_admin', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const boss = await mkUser(uniqueUsername('atc_boss'), 'boss');
    bossToken = boss.token;
    bossId = boss.id;
    const sysadmin = await mkUser(uniqueUsername('atc_sysadmin'), 'sys_admin');
    sysadminToken = sysadmin.token;
    sysadminId = sysadmin.id;
    const sales = await mkUser(uniqueUsername('atc_sales'), 'sales_ops');
    salesToken = sales.token;
  });

  afterAll(async () => {
    // 只清本 spec 维度：本运行创建的任务及其事件 + 同源通知（测试库有历史数据，禁全库清）
    await prisma.notification.deleteMany({ where: { sourceId: { in: mineIds } } });
    if (mineIds.length > 0) {
      await prisma.aiTaskEvent.deleteMany({ where: { taskId: { in: mineIds } } });
      await prisma.aiTask.deleteMany({ where: { id: { in: mineIds } } });
    }
    await app.close();
  });

  describe('Task1：列表与详情（只读）', () => {
    let helloId = '';

    it('boss 建hello 任务后：列表含该任务，筛选生效，详情含 created 事件', async () => {
      const created = await request(app.getHttpServer() as Server)
        .post('/api/v1/ai/tasks/hello')
        .set('Authorization', `Bearer ${bossToken}`)
        .send({ name: `atc_${tag}` })
        .expect(201);
      helloId = (created.body as AiTaskRow).id;
      mineIds.push(helloId);
      // 假网关同步闭环：hello 任务即达终态 done
      expect((created.body as AiTaskRow).status).toBe('done');

      const list = await request(app.getHttpServer() as Server)
        .get('/api/v1/ai/tasks')
        .set('Authorization', `Bearer ${bossToken}`)
        .expect(200);
      const rows = list.body as AiTaskRow[];
      expect(rows.some((t) => t.id === helloId && t.taskType === 'hello')).toBe(true);

      // 筛选：status+taskType 组合命中；异 status 筛选不含本任务（成员断言，不碰计数）
      const filtered = await request(app.getHttpServer() as Server)
        .get('/api/v1/ai/tasks?status=done&taskType=hello')
        .set('Authorization', `Bearer ${bossToken}`)
        .expect(200);
      expect((filtered.body as AiTaskRow[]).some((t) => t.id === helloId)).toBe(true);
      const other = await request(app.getHttpServer() as Server)
        .get('/api/v1/ai/tasks?status=degraded')
        .set('Authorization', `Bearer ${bossToken}`)
        .expect(200);
      expect((other.body as AiTaskRow[]).some((t) => t.id === helloId)).toBe(false);

      // 详情：task + events（createdAt asc，首事件为 created → pending）
      const detail = await request(app.getHttpServer() as Server)
        .get(`/api/v1/ai/tasks/${helloId}`)
        .set('Authorization', `Bearer ${bossToken}`)
        .expect(200);
      const body = detail.body as { task: AiTaskRow; events: EventRow[] };
      expect(body.task.id).toBe(helloId);
      expect(body.events.length).toBeGreaterThanOrEqual(1);
      expect(body.events[0].fromStatus).toBeNull();
      expect(body.events[0].toStatus).toBe('pending');
      for (let i = 1; i < body.events.length; i++) {
        expect(new Date(body.events[i].createdAt).getTime()).toBeGreaterThanOrEqual(
          new Date(body.events[i - 1].createdAt).getTime(),
        );
      }
    });

    it('详情 404：不存在的任务 id', async () => {
      await request(app.getHttpServer() as Server)
        .get('/api/v1/ai/tasks/nonexistent-id')
        .set('Authorization', `Bearer ${bossToken}`)
        .expect(404);
    });

    it('权限：sys_admin 200，sales_ops 403（列表与详情）', async () => {
      await request(app.getHttpServer() as Server)
        .get('/api/v1/ai/tasks')
        .set('Authorization', `Bearer ${sysadminToken}`)
        .expect(200);
      await request(app.getHttpServer() as Server)
        .get('/api/v1/ai/tasks')
        .set('Authorization', `Bearer ${salesToken}`)
        .expect(403);
      await request(app.getHttpServer() as Server)
        .get(`/api/v1/ai/tasks/${helloId}`)
        .set('Authorization', `Bearer ${salesToken}`)
        .expect(403);
    });
  });

  describe('Task2：重试与接管', () => {
    /** 直插一条 degraded 任务（唯一 tag 于 inputSummary，载体键用 note——name 属脱敏键会被改写），
     * 绕过通道闭环专测控制台语义 */
    const insertDegraded = async (): Promise<AiTaskRow> => {
      const row = await prisma.aiTask.create({
        data: {
          taskType: 'hello',
          refType: 'lead',
          refId: `lead_atc_${tag}`,
          status: 'degraded',
          inputSummary: JSON.stringify({ note: `atc_${tag}` }),
        },
      });
      mineIds.push(row.id);
      return row;
    };

    it('degraded 任务 retry：201 新任务继承 refType/refId，原任务状态不变', async () => {
      const original = await insertDegraded();
      const res = await request(app.getHttpServer() as Server)
        .post(`/api/v1/ai/tasks/${original.id}/retry`)
        .set('Authorization', `Bearer ${bossToken}`)
        .expect(201);
      const retried = res.body as AiTaskRow;
      mineIds.push(retried.id);
      // 新任务：ref 继承、inputSummary 重放（脱敏摘要经 maskDeep 后 tag 仍保留——note 非敏感键）
      expect(retried.id).not.toBe(original.id);
      expect(retried.taskType).toBe('hello');
      expect(retried.refType).toBe('lead');
      expect(retried.refId).toBe(`lead_atc_${tag}`);
      expect(retried.inputSummary).toContain(tag);
      // 原任务不被修改（重试=新任务，非原地重启）
      const after = await prisma.aiTask.findUniqueOrThrow({ where: { id: original.id } });
      expect(after.status).toBe('degraded');
      expect(after.retryCount).toBe(0);
    });

    it('done 任务 retry → 409（仅 failed|degraded 可重试）', async () => {
      const created = await request(app.getHttpServer() as Server)
        .post('/api/v1/ai/tasks/hello')
        .set('Authorization', `Bearer ${bossToken}`)
        .send({ name: `atc_done_${tag}` })
        .expect(201);
      const doneId = (created.body as AiTaskRow).id;
      mineIds.push(doneId);
      await request(app.getHttpServer() as Server)
        .post(`/api/v1/ai/tasks/${doneId}/retry`)
        .set('Authorization', `Bearer ${bossToken}`)
        .expect(409);
    });

    it('takeover：写 manual_takeover 事件且 toStatus 不变，重复接管幂等', async () => {
      const task = await insertDegraded();
      const eventsBefore = await prisma.aiTaskEvent.count({ where: { taskId: task.id } });

      const first = await request(app.getHttpServer() as Server)
        .post(`/api/v1/ai/tasks/${task.id}/takeover`)
        .set('Authorization', `Bearer ${bossToken}`)
        .expect(200);
      expect(first.body).toEqual({ id: task.id, tookOver: true });

      // 事件 +1，toStatus 保持原状态（接管=标记，不迁移状态机）
      const eventsMid = await prisma.aiTaskEvent.findMany({
        where: { taskId: task.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(eventsMid.length).toBe(eventsBefore + 1);
      expect(eventsMid[eventsMid.length - 1].toStatus).toBe('degraded');
      expect(eventsMid[eventsMid.length - 1].reason).toBe('manual_takeover');

      // 幂等：重复接管返回 200 且不重复写事件
      const second = await request(app.getHttpServer() as Server)
        .post(`/api/v1/ai/tasks/${task.id}/takeover`)
        .set('Authorization', `Bearer ${bossToken}`)
        .expect(200);
      expect(second.body).toEqual({ id: task.id, tookOver: true });
      const eventsAfter = await prisma.aiTaskEvent.count({ where: { taskId: task.id } });
      expect(eventsAfter).toBe(eventsBefore + 1);
    });

    it('权限：sales_ops retry/takeover 均 403', async () => {
      const task = await insertDegraded();
      await request(app.getHttpServer() as Server)
        .post(`/api/v1/ai/tasks/${task.id}/retry`)
        .set('Authorization', `Bearer ${salesToken}`)
        .expect(403);
      await request(app.getHttpServer() as Server)
        .post(`/api/v1/ai/tasks/${task.id}/takeover`)
        .set('Authorization', `Bearer ${salesToken}`)
        .expect(403);
    });
  });

  describe('Task3：降级/失败通知接线', () => {
    /** 直插一条 dispatched 任务（deadline 已过 → 超时扫描源） */
    const insertOverdue = async (): Promise<AiTaskRow> => {
      const row = await prisma.aiTask.create({
        data: {
          taskType: 'hello',
          status: 'dispatched',
          inputSummary: JSON.stringify({ note: `atc_to_${tag}` }),
          deadlineAt: new Date(Date.now() - 60_000),
          dispatchedAt: new Date(Date.now() - 120_000),
        },
      });
      mineIds.push(row.id);
      return row;
    };

    /** 等待尽力而为的异步通知落库并返回该条 */
    const waitNotification = async (where: Record<string, unknown>): Promise<NotificationRow> => {
      let found: NotificationRow | null = null;
      await vi.waitFor(
        async () => {
          found = await prisma.notification.findFirst({ where, orderBy: { createdAt: 'desc' } });
          expect(found).not.toBeNull();
        },
        { timeout: 3000, interval: 50 },
      );
      return found!;
    };

    it('超时扫描降级落定：boss 与 sys_admin 收 ai_task_degraded（title 含 taskType，link 指控制台）', async () => {
      const task = await insertOverdue();
      const degraded = await app.get(AiHealthService).scanOverdue(new Date());
      expect(degraded).toBeGreaterThanOrEqual(1);
      const after = await prisma.aiTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(after.status).toBe('degraded');

      const ntf = await waitNotification({
        userId: bossId,
        kind: 'ai_task_degraded',
        sourceId: task.id,
      });
      expect(ntf.title).toContain('hello');
      expect(ntf.link).toBe('/ai-tasks');
      // 同一次角色群发：sys_admin 同源收到
      const sysNtf = await prisma.notification.findFirst({
        where: { userId: sysadminId, kind: 'ai_task_degraded', sourceId: task.id },
      });
      expect(sysNtf).not.toBeNull();
    });

    it('回调失败落定：boss 收 ai_task_failed（title 含 taskType）', async () => {
      const task = await insertOverdue();
      // deadline 已过但未扫描：直接走回调失败路径（dispatched → failed），与降级路径区分
      const applied = await app
        .get(AiCallbackService)
        .applyEnvelope(
          task.id,
          { taskType: 'hello', status: 'failed', errorMessage: 'fake 网关执行失败' },
          'http',
        );
      expect(applied.task.status).toBe('failed');

      const ntf = await waitNotification({
        userId: bossId,
        kind: 'ai_task_failed',
        sourceId: task.id,
      });
      expect(ntf.title).toContain('hello');
      expect(ntf.link).toBe('/ai-tasks');
    });
  });
});
