import type { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import { ASSIGN_META_KEYS } from '../src/modules/lead/assign.service';
import { LEAD_EVENT_KIND } from '../src/modules/lead/lead.constants';
import {
  businessMinutesBetween,
  SlaService,
  type BusinessHours,
} from '../src/modules/lead/sla.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { uniqueUsername } from './helpers/unique';
import { buildApp } from './setup';

const d = (iso: string): Date => new Date(iso);

/** 停掉测试 app 的定时任务：SLA 用例直调 service.tick(now)，不赌定时器（P2 模式） */
function stopCronJobs(app: INestApplication): void {
  for (const job of app.get(SchedulerRegistry).getCronJobs().values()) void job.stop();
}

describe('businessMinutesBetween 营业分钟纯函数（D-P3-5）', () => {
  const hours: BusinessHours = { start: '09:00', end: '19:00' };

  it('同营业时段内直接相减', () => {
    expect(businessMinutesBetween(d('2026-08-14T10:00'), d('2026-08-14T10:40'), hours)).toBe(40);
  });

  it('跨非营业时段只计营业内分钟', () => {
    expect(businessMinutesBetween(d('2026-08-14T18:50'), d('2026-08-14T19:10'), hours)).toBe(10);
  });

  it('跨日累加', () => {
    expect(businessMinutesBetween(d('2026-08-14T18:00'), d('2026-08-15T10:00'), hours)).toBe(120);
  });

  it('边界整点：09:00→19:00 计满 600 分钟', () => {
    expect(businessMinutesBetween(d('2026-08-14T09:00'), d('2026-08-14T19:00'), hours)).toBe(600);
  });

  it('边界整点：19:00 后不计时', () => {
    expect(businessMinutesBetween(d('2026-08-14T19:00'), d('2026-08-14T20:00'), hours)).toBe(0);
  });

  it('start 早于当日营业开始：只计 09:00 之后的分钟', () => {
    expect(businessMinutesBetween(d('2026-08-14T07:00'), d('2026-08-14T09:30'), hours)).toBe(30);
  });
});

describe('P3-03 SLA 营业分钟时钟（集成）', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let auth: AuthService;
  let sla: SlaService;
  const password = 'S3cure-Passw0rd!';
  let leadSeq = 0;

  const mkUser = async (role: string): Promise<{ id: string; username: string; token: string }> => {
    const username = uniqueUsername(`sla_${role}`);
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
    const user = await prisma.user.create({
      data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
    const res = await request(server).post('/api/v1/auth/login').send({ username, password });
    return { id: user.id, username, token: (res.body as { accessToken: string }).accessToken };
  };

  const newLeadNo = () => `L-SLA-${Date.now()}-${++leadSeq}`;

  const mkLead = (data: {
    receivedAt?: Date;
    ownerUserId?: string | null;
    sourcePlatform?: string;
    acquisitionMethod?: string | null;
    firstContactAttemptAt?: Date | null;
  }) =>
    prisma.lead.create({
      data: {
        leadNo: newLeadNo(),
        sourceCategory: 'online',
        sourcePlatform: data.sourcePlatform ?? '抖音',
        acquisitionMethod: data.acquisitionMethod ?? null,
        ownerUserId: data.ownerUserId ?? null,
        receivedAt: data.receivedAt ?? new Date(),
        firstContactAttemptAt: data.firstContactAttemptAt ?? null,
      },
    });

  beforeAll(async () => {
    app = await buildApp();
    stopCronJobs(app);
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    sla = app.get(SlaService);
    for (const code of ['boss', 'store_manager', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('20 营业分钟触发 sla_remind 且幂等（二次 tick 不重复）', async () => {
    const lead = await mkLead({ receivedAt: d('2026-08-14T09:00') });
    await sla.tick(d('2026-08-14T09:20'));

    let events = await prisma.leadEvent.findMany({
      where: { leadId: lead.id, kind: LEAD_EVENT_KIND.SLA_REMIND },
    });
    expect(events).toHaveLength(1);

    // 仍在 20~30 区间二次 tick：同类事件已存在，不重复
    await sla.tick(d('2026-08-14T09:25'));
    events = await prisma.leadEvent.findMany({
      where: { leadId: lead.id, kind: LEAD_EVENT_KIND.SLA_REMIND },
    });
    expect(events).toHaveLength(1);
  });

  it('30 营业分钟触发 sla_breach', async () => {
    const lead = await mkLead({ receivedAt: d('2026-08-14T09:00') });
    await sla.tick(d('2026-08-14T09:30'));

    const events = await prisma.leadEvent.findMany({
      where: { leadId: lead.id, kind: LEAD_EVENT_KIND.SLA_BREACH },
    });
    expect(events).toHaveLength(1);
  });

  it('60 营业分钟升级：自动改派 boss 且写 sla_escalate 事件', async () => {
    const boss = await mkUser('boss');
    const sales = await mkUser('sales_ops');
    await prisma.systemMeta.upsert({
      where: { key: ASSIGN_META_KEYS.boss },
      create: { key: ASSIGN_META_KEYS.boss, value: boss.username },
      update: { value: boss.username },
    });

    const lead = await mkLead({ receivedAt: d('2026-08-14T09:00'), ownerUserId: sales.id });
    await sla.tick(d('2026-08-14T10:00'));

    const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(persisted.ownerUserId).toBe(boss.id);

    const evt = await prisma.leadEvent.findFirst({
      where: { leadId: lead.id, kind: LEAD_EVENT_KIND.SLA_ESCALATE },
    });
    expect(evt).not.toBeNull();
  });

  it('非营业时间不计时：19:01 入库 21:00 tick 不触发任何事件', async () => {
    const lead = await mkLead({ receivedAt: d('2026-08-14T19:01') });
    await sla.tick(d('2026-08-14T21:00'));

    const events = await prisma.leadEvent.findMany({ where: { leadId: lead.id } });
    expect(events).toHaveLength(0);
  });

  it('已完成首次触达的 lead 不再计时', async () => {
    const lead = await mkLead({
      receivedAt: d('2026-08-14T09:00'),
      firstContactAttemptAt: d('2026-08-14T09:01'),
    });
    await sla.tick(d('2026-08-14T10:00'));

    const events = await prisma.leadEvent.findMany({ where: { leadId: lead.id } });
    expect(events).toHaveLength(0);
  });

  it('contact-attempt 写 firstContactAttemptAt；customer-reply 写 firstCustomerReplyAt', async () => {
    const owner = await mkUser('sales_ops');
    const lead = await mkLead({ ownerUserId: owner.id });

    const ca = await request(server)
      .post(`/api/v1/leads/${lead.id}/contact-attempt`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({});
    expect(ca.status).toBe(200);
    expect((ca.body as { firstContactAttemptAt: string }).firstContactAttemptAt).toBeTruthy();

    const afterAttempt = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(afterAttempt.firstContactAttemptAt).not.toBeNull();
    expect(afterAttempt.firstCustomerReplyAt).toBeNull();

    const cr = await request(server)
      .post(`/api/v1/leads/${lead.id}/customer-reply`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({});
    expect(cr.status).toBe(200);

    const afterReply = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(afterReply.firstCustomerReplyAt).not.toBeNull();
  });

  it('contact-attempt 越权：sales_ops 操作他人客资 → 403 LEAD_NOT_OWNER', async () => {
    const s1 = await mkUser('sales_ops');
    const s2 = await mkUser('sales_ops');
    const lead = await mkLead({ ownerUserId: s1.id });

    const res = await request(server)
      .post(`/api/v1/leads/${lead.id}/contact-attempt`)
      .set('Authorization', `Bearer ${s2.token}`)
      .send({});
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('LEAD_NOT_OWNER');
  });
});
