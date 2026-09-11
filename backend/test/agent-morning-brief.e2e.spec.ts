/** 经营晨报（V1.5 批次2）：复用 BossAggregator+skill-boss-agent；同同行日报的巡检/补跑/幂等模式；
 * 推送目标 = boss 角色用户 ∪ persona 映射为 boss 的用户（老板娘）。 */
import type { Server } from 'node:http';

import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  GatewayRunResult,
  OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import { MorningBriefService } from '../src/modules/agent/morning-brief.service';
import { PersonaService } from '../src/modules/agent/persona.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

const password = 'S3cure-Passw0rd!';

class BriefGateway implements OpenClawGateway {
  last?: SubmitTaskRequest;
  submit(req: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.last = req;
    const output =
      req.taskType === 'boss.morning_brief'
        ? { reply: '今日晨报：待审批 2 项，跟进暂无。（fake）' }
        : { greeting: '你好（fake）', model: 'fake' };
    return Promise.resolve({ status: 'done', output });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve(void 0);
  }
}

describe('经营晨报（V1.5 批次2）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let brief: MorningBriefService;
  let persona: PersonaService;
  const gateway = new BriefGateway();
  let bossToken = '';
  let salesToken = '';
  let bossId = '';
  let keeperId = ''; // 映射为 boss 的销售账号（老板娘形态）
  let salesId = '';

  beforeAll(async () => {
    app = await buildApp(gateway);
    prisma = app.get(PrismaService);
    // 共享测试库隔离：清本套件历史残留（中断运行遗留的幂等键与通知）
    await prisma.systemMeta.deleteMany({ where: { key: { contains: 'boss.brief.' } } });
    await prisma.notification.deleteMany({ where: { kind: 'boss.morning_brief' } });
    auth = app.get(AuthService);
    brief = app.get(MorningBriefService);
    persona = app.get(PersonaService);
    for (const code of ['boss', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const mk = async (role: string) => {
      const username = uniqueUsername('mb');
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
    bossId = boss.id;
    const keeper = await mk('sales_ops');
    keeperId = keeper.id;
    const sales = await mk('sales_ops');
    salesToken = sales.token;
    salesId = sales.id;
  });
  afterAll(async () => {
    await prisma.systemMeta.deleteMany({
      where: { key: { contains: 'boss.brief.' } },
    });
    await prisma.systemMeta.deleteMany({ where: { key: 'agent.persona.map' } });
    await prisma.notification.deleteMany({ where: { kind: 'boss.morning_brief' } });
    await app.close();
  });

  it('runIfDue：生成晨报任务（boss.morning_brief、注入 structuredContext）并推送 boss∪映射用户', async () => {
    await persona.setEntry(
      { sub: 'op', username: 'op', type: 'access' },
      { userId: keeperId, persona: 'boss' },
    );
    const res = await brief.runIfDue();
    expect(res.generated).toBe(true);
    expect(gateway.last?.taskType).toBe('boss.morning_brief');
    expect(String(gateway.last?.context?.structuredContext)).toContain('【approvals】');
    // 推送目标：boss 角色 + persona 映射 boss（老板娘）；普通销售不收
    const notified = await prisma.notification.findMany({
      where: { kind: 'boss.morning_brief' },
      select: { userId: true },
    });
    const ids = notified.map((n) => n.userId);
    expect(ids).toContain(bossId);
    expect(ids).toContain(keeperId);
    expect(ids).not.toContain(salesId);
  });

  it('幂等：当天已生成 → already-done 不再发', async () => {
    const before = await prisma.notification.count({ where: { kind: 'boss.morning_brief' } });
    const res = await brief.runIfDue();
    expect(res).toEqual({ generated: false, reason: 'already-done' });
    const after = await prisma.notification.count({ where: { kind: 'boss.morning_brief' } });
    expect(after).toBe(before); // 未新增（收件人含库内其他 boss 用户，不赌精确计数）
  });

  it('手动触发端点：boss 200 返回当日晨报；sales 403；已生成时返回既有内容', async () => {
    const denied = await request(app.getHttpServer() as Server)
      .post('/api/v1/agent/morning-brief/run')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(denied.status).toBe(403);
    const ok = await request(app.getHttpServer() as Server)
      .post('/api/v1/agent/morning-brief/run')
      .set('Authorization', `Bearer ${bossToken}`);
    expect(ok.status).toBe(200);
    const body = ok.body as { generated: boolean; date: string; content: string | null };
    expect(body.generated).toBe(false); // 上面已生成过
    expect(body.content).toContain('今日晨报');
  });

  it('开关：WG_BOSS_BRIEF=off 时 runIfDue 直接跳过', async () => {
    const prev = process.env.WG_BOSS_BRIEF;
    process.env.WG_BOSS_BRIEF = 'off';
    try {
      const res = await brief.runIfDue();
      expect(res).toEqual({ generated: false, reason: 'disabled' });
    } finally {
      if (prev === undefined) delete process.env.WG_BOSS_BRIEF;
      else process.env.WG_BOSS_BRIEF = prev;
    }
  });
});
