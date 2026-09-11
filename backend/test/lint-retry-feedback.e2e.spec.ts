/** lint 拦截重试反馈（M02 T1）：postLint hard 拦截（极限词/英文泄漏）落 FAILED 后，
 * 重试不再盲重放——重试载荷注入 lintFeedback 携带失败原因，模型知因再答
 * （实况：短视频选题连续 4 次极限词拦截，盲重放模型不知道上轮为何被拦）。
 * ① 自动重试（submitTaskAutoRetry，经同行动态日报 boss 手动触发的真实提交路径）：
 *    首轮极限词被拦 → 重试载荷含 lintFeedback，次轮干净 → done；
 * ② 非 lint 失败：自动重试仍盲重放（行为不变，inputSummary 不含 lintFeedback）；
 * ③ 手动重试（POST /ai/tasks/:id/retry）：lint 失败任务重放 payload 注入同款 lintFeedback。
 * 注意：agent chat（POST /agent/chat）走 submitTask 直连无自动重试（代码事实），
 * 自动重试场景用同行动态日报端点——它经 submitTaskAutoRetry 提交 sales.agent.chat
 * （带 postLint 的任务型），是全链路里两条能力真实交汇的提交路径。 */
import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import type {
  GatewayRunResult,
  OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

/** 干净输出（过 lint 无违规） */
const CLEAN: GatewayRunResult = {
  status: 'done',
  output: { reply: '好的，为您介绍：店里窗膜套餐从入门到旗舰都有，欢迎到店咨询。' },
};
/** 极限词输出（R3 hard → 任务 FAILED，errorMessage=lint 拦截：lint:banned-words：…） */
const BANNED: GatewayRunResult = {
  status: 'done',
  output: { reply: '我们是全网最低价，欢迎到店咨询。' },
};

/** 假网关：script 按提交次序回放（取尽后复用队尾），submitted 记录全部提交载荷——
 * 断言「重试轮的 context 确实携带 lintFeedback 到达通道」（output-lint.e2e 的 FakeGateway 手法） */
class ScriptedGateway implements OpenClawGateway {
  script: GatewayRunResult[] = [CLEAN];
  submitted: SubmitTaskRequest[] = [];
  submit(req: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.submitted.push(req);
    const next =
      this.script.length > 1 ? (this.script.shift() as GatewayRunResult) : this.script[0];
    return Promise.resolve({ ...next });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** 任务行（只断言用到的字段） */
interface TaskRow {
  id: string;
  taskType: string;
  status: string;
  inputSummary: string;
  errorMessage?: string | null;
}

/** 本地日期键（与服务端 competitor-daily 同口径：年-月-日，门店本地时区） */
const todayKey = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

describe('lint 拦截重试反馈（M02 T1）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const gateway = new ScriptedGateway();
  const password = 'S3cure-Passw0rd!';
  let bossToken = '';
  let salesToken = '';
  /** 本运行创建的任务 id（③ 的 chat/retry 任务；①② 的任务按 refId 在 beforeEach/afterAll 清） */
  const mineIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp(gateway);
    // 停调度任务，避免超时扫描/巡检定时器干扰同步闭环断言（output-lint.e2e 同款手法）
    const registry = app.get(SchedulerRegistry);
    for (const job of registry.getCronJobs().values()) void job.stop();
    for (const name of registry.getIntervals()) {
      clearInterval(registry.getInterval(name) as NodeJS.Timeout);
    }
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const mkUser = async (role: string): Promise<string> => {
      const username = uniqueUsername(`lrf_${role}`);
      const user = await prisma.user.create({
        data: {
          username,
          passwordHash: await auth.hashPassword(password),
          displayName: username,
        },
      });
      const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username, password });
      return (res.body as { accessToken: string }).accessToken;
    };
    bossToken = await mkUser('boss');
    salesToken = await mkUser('sales_ops');
  });

  /** 清同行动态日报当日痕迹（幂等标记/通知/任务）——①② 每用例独立验证生成语义 */
  const clearDaily = async (): Promise<void> => {
    const key = todayKey();
    await prisma.systemMeta.deleteMany({
      where: { key: { in: [`competitor.daily.done.${key}`, `competitor.daily.content.${key}`] } },
    });
    await prisma.notification.deleteMany({ where: { kind: 'competitor.daily', sourceId: key } });
    const stale = await prisma.aiTask.findMany({
      where: { refId: `competitor-daily-${key}` },
      select: { id: true },
    });
    if (stale.length > 0) {
      const ids = stale.map((t) => t.id);
      await prisma.aiTaskEvent.deleteMany({ where: { taskId: { in: ids } } });
      await prisma.aiTask.deleteMany({ where: { id: { in: ids } } });
    }
  };

  afterAll(async () => {
    await clearDaily();
    if (mineIds.length > 0) {
      await prisma.aiTaskEvent.deleteMany({ where: { taskId: { in: mineIds } } });
      await prisma.aiTask.deleteMany({ where: { id: { in: mineIds } } });
    }
    await prisma.user.deleteMany({ where: { username: { contains: 'lrf_' } } });
    await app.close();
  });

  beforeEach(async () => {
    gateway.submitted = [];
    gateway.script = [CLEAN];
    await clearDaily();
  });

  /** 按提交路径取当次运行生成的两条任务（首轮/重试轮，按状态区分而非时间序） */
  const dailyTasks = async (): Promise<{ first: TaskRow; retried: TaskRow }> => {
    const rows = (await prisma.aiTask.findMany({
      where: { taskType: 'sales.agent.chat', refId: `competitor-daily-${todayKey()}` },
      orderBy: { createdAt: 'asc' },
    })) as unknown as TaskRow[];
    const first = rows.find((t) => t.status === 'failed');
    const retried = rows.find((t) => t.status === 'done');
    expect(first).toBeDefined();
    expect(retried).toBeDefined();
    return { first: first as TaskRow, retried: retried as TaskRow };
  };

  const runDaily = () =>
    request(app.getHttpServer() as Server)
      .post('/api/v1/marketing/competitor-daily/run')
      .set('Authorization', `Bearer ${bossToken}`);

  it('① lint 拦截自动重试：重试载荷携带失败原因，次轮干净 → 任务 done', async () => {
    gateway.script = [BANNED, CLEAN];
    const res = await runDaily().expect(200);
    expect((res.body as { generated: boolean }).generated).toBe(true);

    // 恰好两次提交：首轮被拦（failed），重试轮知因再答（done）
    expect(gateway.submitted.length).toBe(2);
    const { first, retried } = await dailyTasks();
    expect(first.errorMessage ?? '').toContain('lint 拦截');
    expect(retried.status).toBe('done');

    // 重试轮到达通道的 context 注入 lintFeedback，含失败原因原文（模型知因再答）
    const feedback = gateway.submitted[1]?.context.lintFeedback;
    expect(String(feedback)).toContain('lint:banned-words');
    expect(String(feedback)).toContain('全网最低');
    // 重试任务的输入摘要同款可见（inputSummary=JSON.stringify(maskedContext)）
    expect(retried.inputSummary).toContain('lintFeedback');
    expect(retried.inputSummary).toContain('lint:banned-words');
  });

  it('② 非 lint 失败自动重试：盲重放行为不变，inputSummary 不含 lintFeedback', async () => {
    gateway.script = [{ status: 'failed', errorMessage: '模型执行异常（非 lint）' }, CLEAN];
    const res = await runDaily().expect(200);
    expect((res.body as { generated: boolean }).generated).toBe(true);

    expect(gateway.submitted.length).toBe(2);
    const { first, retried } = await dailyTasks();
    expect(first.errorMessage).toBe('模型执行异常（非 lint）');
    expect(retried.status).toBe('done');
    // 盲重放：重试载荷与摘要均不含 lintFeedback
    expect(gateway.submitted[1]?.context.lintFeedback).toBeUndefined();
    expect(retried.inputSummary).not.toContain('lintFeedback');
  });

  it('③ 手动重试 lint 失败任务：重放 payload 注入 lintFeedback，次轮干净 → done', async () => {
    gateway.script = [BANNED, CLEAN];
    const chat = await request(app.getHttpServer() as Server)
      .post('/api/v1/agent/chat')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ message: '介绍下店里的窗膜套餐' })
      .expect(201);
    const failedTask = chat.body as TaskRow;
    mineIds.push(failedTask.id);
    // agent chat 走 submitTask 直连（无自动重试）：首轮即终态 failed
    expect(failedTask.status).toBe('failed');
    expect(String(failedTask.errorMessage)).toContain('lint 拦截');

    const res = await request(app.getHttpServer() as Server)
      .post(`/api/v1/ai/tasks/${failedTask.id}/retry`)
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(201);
    const retried = res.body as TaskRow;
    mineIds.push(retried.id);
    expect(retried.status).toBe('done');
    // 手动重试同口径：重放 payload（JSON.parse(inputSummary) + 注入）与通道 context 均含反馈
    expect(retried.inputSummary).toContain('lintFeedback');
    expect(retried.inputSummary).toContain('lint:banned-words');
    const feedback = gateway.submitted[1]?.context.lintFeedback;
    expect(String(feedback)).toContain('lint:banned-words');
  });
});
