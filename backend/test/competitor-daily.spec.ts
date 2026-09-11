import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import { CompetitorDailyService } from '../src/modules/marketing/competitor-daily.service';
import type {
  GatewayRunResult,
  OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import { EmbeddingService } from '../src/modules/knowledge/embedding.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

/** 假网关：记录提交载荷并回显合法 sales.agent.chat 输出（reply=日报正文） */
class FakeAgentGateway implements OpenClawGateway {
  submitted: SubmitTaskRequest[] = [];
  reply = '今日同行动态：① XX 店开业促销（来源：xxx.com）';
  /** 连续 N 次回会触发校验降级的输出（覆盖原次+AutoRetry 次都失败的场景） */
  failTimes = 0;
  /** 2026-08-28 Q1 实况：done 但 reply 是英文思维链（CJK 3%）——日报侧必须拒收 */
  englishLeak = false;

  submit(request: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.submitted.push(request);
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      return Promise.resolve({ status: 'done', output: { unrelated: 1 }, model: 'fake' });
    }
    if (this.englishLeak) {
      return Promise.resolve({
        status: 'done',
        output: {
          reply:
            '我来联网搜索本地贴膜动态。Let me search for more recent news. I now have a comprehensive picture. Let me filter out spam and format this as a daily report with max 5 key points.',
        },
        model: 'fake',
      });
    }
    return Promise.resolve({ status: 'done', output: { reply: this.reply }, model: 'fake' });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** 同行动态每日推送（2026-08-27）：巡检生成/幂等/预算失败重试/kill switch/boss 手动触发。 */
describe('同行动态每日推送（competitor.daily）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let gateway: FakeAgentGateway;
  let service: CompetitorDailyService;
  let bossToken = '';
  let salesToken = '';
  const password = 'S3cure-Passw0rd!';
  let seq = 0;

  const mkUser = async (role: string): Promise<string> => {
    const username = uniqueUsername(`cd_${role}`);
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
    const user = await prisma.user.create({
      data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username, password });
    return (res.body as { accessToken: string }).accessToken;
  };

  beforeAll(async () => {
    gateway = new FakeAgentGateway();
    // 知识草稿向量化用未配置桩（p6-replay 先例）：ConfigModule 会读 backend/.env 的真实
    // MiniMax embedding 配置，不覆盖则每条草稿发真实外网调用（3~7 秒/条）——测试既慢又
    // 贴着 5s 默认超时线抖动（2026-08-28 全量并发下复现），还产生真实计费
    app = await buildApp(gateway, [
      {
        token: EmbeddingService,
        value: {
          isConfigured: () => false,
          embed: () => Promise.resolve([] as number[][]),
        } satisfies Partial<EmbeddingService>,
      },
    ]);
    const registry = app.get(SchedulerRegistry);
    for (const job of registry.getCronJobs().values()) void job.stop();
    for (const name of registry.getIntervals()) {
      clearInterval(registry.getInterval(name) as NodeJS.Timeout);
    }
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    service = app.get(CompetitorDailyService);
    for (const code of ['boss', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    bossToken = await mkUser('boss');
    salesToken = await mkUser('sales_ops');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    gateway.submitted = [];
    gateway.englishLeak = false;
    gateway.failTimes = 0;
    // 清当日幂等标记（每用例独立验证幂等语义）
    const key = 'competitor.daily.done.' + new Date().toISOString().slice(0, 10);
    await prisma.systemMeta.deleteMany({ where: { key } });
    await prisma.notification.deleteMany({ where: { kind: 'competitor.daily' } });
    seq += 1;
    void seq;
  });

  it('巡检生成：AI 任务 done → 全员未读通知（kind=competitor.daily，正文带来源）+ 当日标记', async () => {
    const res = await service.runIfDue();
    expect(res.generated).toBe(true);

    const rows = await prisma.notification.findMany({ where: { kind: 'competitor.daily' } });
    expect(rows.length).toBeGreaterThanOrEqual(2); // boss + sales 两人各一条
    expect(rows.every((r) => r.readAt === null)).toBe(true);
    expect(rows[0].body).toContain('来源');
    expect(rows[0].title).toContain('同行动态日报');

    // 提交的是 sales.agent.chat 通道（复用已批 skill 的联网搜索）
    expect(gateway.submitted[0]?.taskType).toBe('sales.agent.chat');
  });

  it('幂等：当日已生成 → 巡检跳过，不产生第二条通知/任务', async () => {
    await service.runIfDue();
    const afterFirst = await prisma.notification.count({ where: { kind: 'competitor.daily' } });
    const res = await service.runIfDue();
    expect(res.generated).toBe(false);
    expect(await prisma.notification.count({ where: { kind: 'competitor.daily' } })).toBe(
      afterFirst,
    );
    expect(gateway.submitted.length).toBe(1);
  });

  it('AI 失败不标记当日完成（下小时自动重试的语义）', async () => {
    gateway.failTimes = 2; // 原次 + AutoRetry 次都给畸形输出 → degraded → generate 抛错
    const res = await service.runIfDue();
    expect(res.generated).toBe(false);
    expect(res.reason).toBe('error');
    const key = 'competitor.daily.done.' + new Date().toISOString().slice(0, 10);
    expect(await prisma.systemMeta.findUnique({ where: { key } })).toBeNull();
  });

  it('英文思维链泄漏拒收（2026-08-28 实况：CJK 3% 的 done 输出不推送、不标记当日完成）', async () => {
    gateway.englishLeak = true;
    const res = await service.runIfDue();
    expect(res.generated).toBe(false);
    expect(res.reason).toBe('error');
    expect(await prisma.notification.count({ where: { kind: 'competitor.daily' } })).toBe(0);
    const key = 'competitor.daily.done.' + new Date().toISOString().slice(0, 10);
    expect(await prisma.systemMeta.findUnique({ where: { key } })).toBeNull();
  });

  it('手动触发：非 boss 403；boss 幂等（当天已生成返回内容不重发）', async () => {
    const forbidden = await request(app.getHttpServer() as Server)
      .post('/api/v1/marketing/competitor-daily/run')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(forbidden.status).toBe(403);

    await service.runIfDue();
    const before = await prisma.notification.count({ where: { kind: 'competitor.daily' } });
    const manual = await request(app.getHttpServer() as Server)
      .post('/api/v1/marketing/competitor-daily/run')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    const body = manual.body as { generated: boolean; content: string | null };
    expect(body.generated).toBe(false); // 当天已生成
    expect(body.content).toContain('同行动态');
    expect(await prisma.notification.count({ where: { kind: 'competitor.daily' } })).toBe(before);
  });
});
