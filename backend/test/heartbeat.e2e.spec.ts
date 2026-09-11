/** 每日脱敏心跳（批次5 心跳）：纯聚合数字零客户数据；幂等/开关/发送器注入/失败重试口径。 */
import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { HeartbeatSender } from '../src/modules/notification/heartbeat.service';
import { HeartbeatService } from '../src/modules/notification/heartbeat.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';

describe('每日心跳（批次5 心跳）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let svc: HeartbeatService;
  const sent: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    svc = app.get(HeartbeatService);
    await prisma.systemMeta.deleteMany({ where: { key: { startsWith: 'heartbeat.done.' } } });
    // 造数：1 条今日客资 + 2 条到期跟进（1 超期）
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const l1 = await prisma.lead.create({
      data: {
        leadNo: 'L-HB-1',
        sourceCategory: 'offline',
        sourcePlatform: 't',
        stage: 'new',
        createdAt: new Date(),
      },
    });
    const l2 = await prisma.lead.create({
      data: {
        leadNo: 'L-HB-2',
        sourceCategory: 'offline',
        sourcePlatform: 't',
        stage: 'new',
        finalStatus: 'active',
        nextFollowUpAt: new Date(Date.now() + 3_600_000),
      },
    });
    const l3 = await prisma.lead.create({
      data: {
        leadNo: 'L-HB-3',
        sourceCategory: 'offline',
        sourcePlatform: 't',
        stage: 'new',
        finalStatus: 'active',
        nextFollowUpAt: new Date(Date.now() - 86_400_000),
      },
    });
    sent.length = 0;
    const fake: HeartbeatSender = (text) => {
      sent.push(text);
      return Promise.resolve();
    };
    svc.setSender(fake);
    (svc as unknown as { leadNos: string[] }).leadNos = [l1.id, l2.id, l3.id];
  });
  afterAll(async () => {
    await prisma.lead.deleteMany({ where: { leadNo: { startsWith: 'L-HB-' } } });
    await prisma.systemMeta.deleteMany({ where: { key: { startsWith: 'heartbeat.done.' } } });
    await app.close();
  });

  it('compose：纯聚合数字，含客资/跟进/超期，无任何客户身份字段', async () => {
    const text = await svc.compose();
    expect(text).toContain('门店系统心跳');
    expect(text).toContain('今日新客资');
    expect(text).toContain('该跟进');
    // 客资编号/姓名/电话等一律不得出现
    expect(text).not.toContain('L-HB');
    expect(text).not.toContain('138');
  });

  it('runIfDue：发送成功写幂等键；当日再跑 already-done 不重发', async () => {
    const r1 = await svc.runIfDue();
    expect(r1.sent).toBe(true);
    expect(sent.length).toBe(1);
    const r2 = await svc.runIfDue();
    expect(r2).toEqual({ sent: false, reason: 'already-done' });
    expect(sent.length).toBe(1);
  });

  it('发送失败不写幂等键（下小时重试）；开关 off 直接跳过', async () => {
    await prisma.systemMeta.deleteMany({ where: { key: { startsWith: 'heartbeat.done.' } } });
    svc.setSender(() => Promise.reject(new Error('渠道暂不可用')));
    const fail = await svc.runIfDue();
    expect(fail).toEqual({ sent: false, reason: 'send-error' });
    const key = `heartbeat.done.${new Date().toISOString().slice(0, 10)}`;
    expect(await prisma.systemMeta.findUnique({ where: { key } })).toBeNull();
    const prev = process.env.WG_HEARTBEAT;
    process.env.WG_HEARTBEAT = 'off';
    try {
      expect(await svc.runIfDue()).toEqual({ sent: false, reason: 'disabled' });
    } finally {
      if (prev === undefined) delete process.env.WG_HEARTBEAT;
      else process.env.WG_HEARTBEAT = prev;
    }
  });
});
