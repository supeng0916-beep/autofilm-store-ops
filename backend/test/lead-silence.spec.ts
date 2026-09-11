import type { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AuthService } from '../src/modules/auth/auth.service';
import { LEAD_EVENT_KIND } from '../src/modules/lead/lead.constants';
import {
  MarkInvalidDto,
  MarkWonDto,
  PauseLeadDto,
  ProposeChurnDto,
  RecordFollowUpDto,
  ReopenLeadDto,
  TakeoverLeadDto,
  TransitionStageDto,
} from '../src/modules/lead/lead.dto';
import { SilenceService } from '../src/modules/lead/silence.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { uniqueUsername } from './helpers/unique';
import { buildApp } from './setup';

function stopCronJobs(app: INestApplication): void {
  for (const job of app.get(SchedulerRegistry).getCronJobs().values()) void job.stop();
}

interface TokenUser {
  id: string;
  username: string;
  token: string;
}

const d = (iso: string): Date => new Date(iso);
const H = 60 * 60 * 1000;
const DAY = 24 * H;

/** 断言入参 schema 剥离 AI output/aiTaskId 字段（结构层 AI 隔离，A02） */
function assertStripsAiFields(schema: z.ZodTypeAny, validBody: Record<string, unknown>): void {
  const parsed = schema.safeParse({
    ...validBody,
    output: { intent: 'high', summary: 'AI 输出' },
    aiTaskId: 'ai-123',
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data).not.toHaveProperty('output');
    expect(parsed.data).not.toHaveProperty('aiTaskId');
  }
}

const schemaOf = (dto: { schema: unknown }): z.ZodTypeAny => dto.schema as z.ZodTypeAny;

describe('P3-04 沉默链＋复活＋AI 隔离（集成）', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let auth: AuthService;
  let silence: SilenceService;
  const password = 'S3cure-Passw0rd!';
  let leadSeq = 0;

  const mkUser = async (role: string): Promise<TokenUser> => {
    const username = uniqueUsername(`sl_${role}`);
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
    const user = await prisma.user.create({
      data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
    const res = await request(server).post('/api/v1/auth/login').send({ username, password });
    return { id: user.id, username, token: (res.body as { accessToken: string }).accessToken };
  };

  const mkLead = (ownerUserId: string | null, extra: Record<string, unknown> = {}) =>
    prisma.lead.create({
      data: {
        leadNo: `L-SL-${Date.now()}-${++leadSeq}`,
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        ownerUserId,
        ...extra,
      },
    });

  beforeAll(async () => {
    app = await buildApp();
    stopCronJobs(app);
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    silence = app.get(SilenceService);
    for (const code of ['boss', 'store_manager', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  describe('沉默链', () => {
    it('24h→risk、72h→follow_due、7d→nurture+finalStatus=silence，逐档事件', async () => {
      const owner = await mkUser('sales_ops');
      const t0 = d('2026-08-14T08:00:00');
      const lead = await mkLead(owner.id, { firstCustomerReplyAt: t0 });

      await silence.tick(new Date(t0.getTime() + 25 * H));
      let persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.silenceStage).toBe('risk');
      expect(persisted.finalStatus).toBe('active');

      await silence.tick(new Date(t0.getTime() + 73 * H));
      persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.silenceStage).toBe('follow_due');

      await silence.tick(new Date(t0.getTime() + 8 * DAY));
      persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.silenceStage).toBe('nurture');
      expect(persisted.finalStatus).toBe('silence');

      const marked = await prisma.leadEvent.findMany({
        where: { leadId: lead.id, kind: LEAD_EVENT_KIND.SILENCE_MARKED },
        orderBy: { occurredAt: 'asc' },
      });
      expect(marked.map((e) => (e.content as { stage: string }).stage)).toEqual([
        'risk',
        'follow_due',
        'nurture',
      ]);
    });

    it('只升档不跳档：长时间未联系一次 tick 仅推进一档', async () => {
      const owner = await mkUser('sales_ops');
      const t0 = d('2026-08-14T08:00:00');
      const lead = await mkLead(owner.id, { firstCustomerReplyAt: t0 });

      // 一次 tick 距今 8 天：只升到 risk，不直接跳到 nurture
      await silence.tick(new Date(t0.getTime() + 8 * DAY));
      const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.silenceStage).toBe('risk');
      expect(persisted.finalStatus).toBe('active');
    });

    it('14 天不自动判流失：仅产生 churn_remind_14d 提醒事件（幂等）', async () => {
      const owner = await mkUser('sales_ops');
      const t0 = d('2026-08-14T08:00:00');
      const lead = await mkLead(owner.id, {
        firstCustomerReplyAt: t0,
        silenceStage: 'nurture',
        finalStatus: 'silence',
      });

      await silence.tick(new Date(t0.getTime() + 15 * DAY));
      const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.finalStatus).toBe('silence'); // 不自动判流失

      const reminds = await prisma.leadEvent.findMany({
        where: { leadId: lead.id, kind: LEAD_EVENT_KIND.CHURN_REMIND_14D },
      });
      expect(reminds).toHaveLength(1);

      // 幂等：二次 tick 不重复
      await silence.tick(new Date(t0.getTime() + 15 * DAY + H));
      const remindsAfter = await prisma.leadEvent.findMany({
        where: { leadId: lead.id, kind: LEAD_EVENT_KIND.CHURN_REMIND_14D },
      });
      expect(remindsAfter).toHaveLength(1);
    });

    it('复活：customer-reply 刷新沉默基线（时钟驱动两次复活，无 flapping、无冷却期）', async () => {
      const owner = await mkUser('sales_ops');
      const t0 = new Date(Date.now() - 8 * DAY);
      const lead = await mkLead(owner.id, {
        silenceStage: 'nurture',
        finalStatus: 'silence',
        firstCustomerReplyAt: t0,
        lastFollowUpAt: t0,
      });

      // 第一次复活
      const first = await request(server)
        .post(`/api/v1/leads/${lead.id}/customer-reply`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({});
      expect(first.status).toBe(200);
      let persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.silenceStage).toBe('none');
      expect(persisted.finalStatus).toBe('active');
      expect(persisted.ownerUserId).toBe(owner.id);
      // 基线已刷新到最近（lastFollowUpAt 远大于 8 天前的 t0）
      expect(persisted.lastFollowUpAt!.getTime()).toBeGreaterThan(t0.getTime() + 7 * DAY);

      // 关键：复活后 1 小时 tick 不立即回 risk（无 flapping）
      await silence.tick(new Date(Date.now() + H));
      persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.silenceStage).toBe('none');
      expect(persisted.finalStatus).toBe('active');

      // 时钟推进再次沉默（逐档：25h→risk、73h→follow_due、8d→nurture）
      await silence.tick(new Date(Date.now() + 25 * H));
      await silence.tick(new Date(Date.now() + 73 * H));
      await silence.tick(new Date(Date.now() + 8 * DAY));
      persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.silenceStage).toBe('nurture');
      expect(persisted.finalStatus).toBe('silence');

      // 第二次复活（无冷却期）
      const second = await request(server)
        .post(`/api/v1/leads/${lead.id}/customer-reply`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({});
      expect(second.status).toBe(200);
      persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.silenceStage).toBe('none');
      expect(persisted.finalStatus).toBe('active');

      const revived = await prisma.leadEvent.findMany({
        where: { leadId: lead.id, kind: LEAD_EVENT_KIND.REVIVED },
      });
      expect(revived).toHaveLength(2);
    });

    it('AI 隔离：写端点入参 schema 不含 AI output 字段；lead_events 无 AI 直接状态变更', async () => {
      // 1. 结构层：全部写 DTO 的 schema 剥离 output/aiTaskId
      assertStripsAiFields(schemaOf(TransitionStageDto), { stage: 'contacted', reason: '推进' });
      assertStripsAiFields(schemaOf(ProposeChurnDto), { reason: 'price', note: '太贵' });
      assertStripsAiFields(schemaOf(ReopenLeadDto), { reason: '客户重新联系' });
      assertStripsAiFields(schemaOf(MarkWonDto), { amountFen: 100, reason: '成交' });
      assertStripsAiFields(schemaOf(MarkInvalidDto), { reason: '无效' });
      assertStripsAiFields(schemaOf(RecordFollowUpDto), {
        result: '已沟通',
        nextAction: '下次联系',
        nextFollowUpAt: '2026-08-20T10:00:00.000Z',
      });
      assertStripsAiFields(schemaOf(PauseLeadDto), { reason: '暂缓' });
      assertStripsAiFields(schemaOf(TakeoverLeadDto), {
        reason: '接管',
        evidence: '证据',
        nextAction: '下一步',
      });

      // 2. 数据层：状态变更事件 kind 均为显式状态机产生，无 AI 直接写状态 kind
      const stateKinds = [
        LEAD_EVENT_KIND.STAGE_CHANGED,
        LEAD_EVENT_KIND.CHURN_PROPOSED,
        LEAD_EVENT_KIND.CHURN_DECIDED,
        LEAD_EVENT_KIND.SILENCE_MARKED,
        LEAD_EVENT_KIND.REVIVED,
        LEAD_EVENT_KIND.WON,
        LEAD_EVENT_KIND.INVALID,
        LEAD_EVENT_KIND.PAUSED,
        LEAD_EVENT_KIND.RESUMED,
        LEAD_EVENT_KIND.TAKEOVER,
        LEAD_EVENT_KIND.REOPENED,
      ];
      for (const kind of stateKinds) {
        expect(kind.startsWith('ai_')).toBe(false);
      }
      // 唯一 AI 相关 kind 是草稿建议态，不产生状态迁移
      expect(LEAD_EVENT_KIND.INTENT_PROPOSED).toBe('intent_proposed');

      // 3. 集成：带 output/aiTaskId 的 stage 请求，状态推进但 AI 字段不入库/不入事件
      const owner = await mkUser('sales_ops');
      const lead = await mkLead(owner.id);
      const res = await request(server)
        .patch(`/api/v1/leads/${lead.id}/stage`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          stage: 'contacted',
          reason: '正常推进',
          output: { intent: 'high' },
          aiTaskId: 'ai-1',
        });
      expect(res.status).toBe(200);
      const events = await prisma.leadEvent.findMany({ where: { leadId: lead.id } });
      for (const e of events) {
        expect(e.content).not.toHaveProperty('output');
        expect(e.content).not.toHaveProperty('aiTaskId');
      }
    });
  });
});
