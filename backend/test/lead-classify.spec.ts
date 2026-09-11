import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import type {
  GatewayRunResult,
  OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import { scanForLeaks } from '../src/modules/ai-dispatch/masker';
import { LeadClassifyOutputSchema } from '../src/modules/lead/ai/lead-ai.module';
import { LeadClassifyTrigger } from '../src/modules/lead/ai/lead-classify.trigger';
import { LEAD_EVENT_KIND } from '../src/modules/lead/lead.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

/** 记录提交载荷并回显合法 lead.classify 输出的假网关（P2 同款手法） */
class FakeClassifyGateway implements OpenClawGateway {
  submitted: SubmitTaskRequest[] = [];
  output: GatewayRunResult['output'] = {
    level: 'high',
    confidence: 0.85,
    evidence: ['明确车型需求', '主动问价'],
    missingInfo: ['到店时间'],
    nextAction: '预约到店看膜',
  };

  submit(request: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.submitted.push(request);
    return Promise.resolve({ status: 'done', output: this.output, model: 'fake' });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

interface TokenUser {
  id: string;
  username: string;
  token: string;
}

describe('lead.classify（P3-07）', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let auth: AuthService;
  let gateway: FakeClassifyGateway;
  let trigger: LeadClassifyTrigger;
  let owner: TokenUser;
  const password = 'S3cure-Passw0rd!';
  let leadSeq = 0;

  const mkUser = async (role: string): Promise<TokenUser> => {
    const username = uniqueUsername(`lc_${role}`);
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
    const user = await prisma.user.create({
      data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
    const res = await request(server).post('/api/v1/auth/login').send({ username, password });
    return { id: user.id, username, token: (res.body as { accessToken: string }).accessToken };
  };

  const mkLead = (ownerUserId: string, extra: Record<string, unknown> = {}) =>
    prisma.lead.create({
      data: {
        leadNo: `L-CL-${Date.now()}-${++leadSeq}`,
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        ownerUserId,
        ...extra,
      },
    });

  const classifyTaskOf = (leadId: string) =>
    prisma.aiTask.findFirst({
      where: { refType: 'lead', refId: leadId, taskType: 'lead.classify' },
    });

  const classify = (leadId: string, token: string) =>
    request(server)
      .post(`/api/v1/leads/${leadId}/classify`)
      .set('Authorization', `Bearer ${token}`)
      .send();

  beforeAll(async () => {
    gateway = new FakeClassifyGateway();
    app = await buildApp(gateway);
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    trigger = app.get(LeadClassifyTrigger);
    for (const code of ['boss', 'store_manager', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    owner = await mkUser('sales_ops');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    gateway.submitted = [];
  });

  it('客户首次回复自动触发分级任务（幂等）', async () => {
    const lead = await mkLead(owner.id);
    const res = await request(server)
      .post(`/api/v1/leads/${lead.id}/customer-reply`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send();
    expect(res.status).toBe(200);

    const task = await classifyTaskOf(lead.id);
    expect(task).not.toBeNull();
    expect(task!.status).toBe('done');
    expect(task!.refType).toBe('lead');
    expect(task!.refId).toBe(lead.id);

    // 上下文经脱敏：客户以 refId 假名出现，不含电话/微信/chatLink
    const submitted = gateway.submitted[0];
    expect(typeof submitted.context.refId).toBe('string');
    expect(Object.keys(submitted.context)).not.toContain('phone');
    expect(Object.keys(submitted.context)).not.toContain('wechat');
    expect(Object.keys(submitted.context)).not.toContain('chatLink');
    expect(scanForLeaks(submitted)).toEqual([]);

    // 幂等：预置非终态任务后再次触发，不产生第二条
    await prisma.aiTask.create({
      data: { taskType: 'lead.classify', refType: 'lead', refId: lead.id, inputSummary: '{}' },
    });
    await trigger.onReply(lead);
    const all = await prisma.aiTask.findMany({
      where: { refType: 'lead', refId: lead.id, taskType: 'lead.classify' },
    });
    expect(all).toHaveLength(2); // 1 done（首次回复）＋1 手工预置；onReply 因非终态存在而跳过
  });

  it('输出 schema：level/confidence/evidence/missingInfo/nextAction', () => {
    const valid = LeadClassifyOutputSchema.safeParse({
      level: 'high',
      confidence: 0.8,
      evidence: ['明确车型需求'],
      missingInfo: ['到店时间'],
      nextAction: '预约到店',
    });
    expect(valid.success).toBe(true);

    // 缺 level 或 confidence 越界 → 校验失败
    expect(LeadClassifyOutputSchema.safeParse({ confidence: 0.8 }).success).toBe(false);
    expect(LeadClassifyOutputSchema.safeParse({ level: 'high', confidence: 1.5 }).success).toBe(
      false,
    );
    // evidence/missingInfo 缺省为 []
    const defaults = LeadClassifyOutputSchema.safeParse({ level: 'pending', confidence: 0.5 });
    expect(defaults.success).toBe(true);
    if (defaults.success) {
      expect(defaults.data.evidence).toEqual([]);
      expect(defaults.data.missingInfo).toEqual([]);
    }
  });

  it('未确认建议不影响业务：队列排序不读取建议态等级', async () => {
    const early = new Date('2099-01-01T00:00:00.000Z');
    const late = new Date('2099-01-02T00:00:00.000Z');
    const leadEarly = await mkLead(owner.id, { receivedAt: early });
    const leadLate = await mkLead(owner.id, { receivedAt: late });

    // 对 leadEarly 提交分级建议（done，AI 建议 high），不确认
    const res = await classify(leadEarly.id, owner.token);
    expect(res.status).toBe(200);
    expect(await classifyTaskOf(leadEarly.id)).not.toBeNull();

    // 建议态：未确认不写业务字段，intentLevel 仍 pending
    const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: leadEarly.id } });
    expect(persisted.intentLevel).toBe('pending');
    expect(persisted.intentConfirmedBy).toBeNull();

    // 队列仍按 receivedAt desc 排序，不读建议态等级（leadLate 在前，leadEarly 建议 high 不插队）
    const listRes = await request(server)
      .get('/api/v1/leads')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(listRes.status).toBe(200);
    const list = listRes.body as Array<{ id: string; intentLevel: string }>;
    const ids = list.map((l) => l.id);
    expect(ids.indexOf(leadLate.id)).toBeLessThan(ids.indexOf(leadEarly.id));
    expect(list.find((l) => l.id === leadEarly.id)!.intentLevel).toBe('pending');
  });

  it('确认后写 intentLevel 与 intent_confirmed 事件；改判记录 aiLevel/humanLevel', async () => {
    // 确认（不改判）：沿用 AI 建议等级
    const leadA = await mkLead(owner.id);
    await classify(leadA.id, owner.token);
    const taskA = await classifyTaskOf(leadA.id);
    expect(taskA).not.toBeNull();

    const confirmRes = await request(server)
      .post(`/api/v1/leads/${leadA.id}/intent-confirm`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ taskId: taskA!.id });
    expect(confirmRes.status).toBe(200);

    const pa = await prisma.lead.findUniqueOrThrow({ where: { id: leadA.id } });
    expect(pa.intentLevel).toBe('high');
    expect(pa.intentConfirmedBy).toBe(owner.id);
    const evtA = await prisma.leadEvent.findFirst({
      where: { leadId: leadA.id, kind: LEAD_EVENT_KIND.INTENT_CONFIRMED },
    });
    expect(evtA).not.toBeNull();
    expect((evtA!.content as { overridden: boolean }).overridden).toBe(false);

    // 改判：level=low 与 AI 建议 high 不一致，记录 aiLevel/humanLevel/reason
    const leadB = await mkLead(owner.id);
    await classify(leadB.id, owner.token);
    const taskB = await classifyTaskOf(leadB.id);
    expect(taskB).not.toBeNull();

    const overrideRes = await request(server)
      .post(`/api/v1/leads/${leadB.id}/intent-confirm`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ taskId: taskB!.id, level: 'low', reason: '客户明确说只是随便看看' });
    expect(overrideRes.status).toBe(200);

    const pb = await prisma.lead.findUniqueOrThrow({ where: { id: leadB.id } });
    expect(pb.intentLevel).toBe('low');
    expect(pb.intentConfirmedBy).toBe(owner.id);
    expect(pb.intentEvidence).toEqual(['明确车型需求', '主动问价']);

    const evtB = await prisma.leadEvent.findFirst({
      where: { leadId: leadB.id, kind: LEAD_EVENT_KIND.INTENT_CONFIRMED },
    });
    expect(evtB).not.toBeNull();
    const content = evtB!.content as {
      aiLevel: string;
      humanLevel: string;
      reason: string;
      overridden: boolean;
    };
    expect(content.aiLevel).toBe('high');
    expect(content.humanLevel).toBe('low');
    expect(content.reason).toBe('客户明确说只是随便看看');
    expect(content.overridden).toBe(true);
  });

  it('2026-08-28 P2：改判必填理由——缺理由/理由不足2字 422；纯确认仍不需理由', async () => {
    const lead = await mkLead(owner.id);
    await classify(lead.id, owner.token);
    const task = await classifyTaskOf(lead.id);
    expect(task).not.toBeNull();

    // 改判不填理由 → 422（此前 reason 可选，留痕缺理由）
    const noReason = await request(server)
      .post(`/api/v1/leads/${lead.id}/intent-confirm`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ taskId: task!.id, level: 'low' });
    expect(noReason.status).toBe(422);
    expect((noReason.body as { message: string }).message).toContain('改判必须填写理由');

    // 理由不足 2 字 → DTO 层先拦（400，min(2) 口径）
    const shortReason = await request(server)
      .post(`/api/v1/leads/${lead.id}/intent-confirm`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ taskId: task!.id, level: 'low', reason: '改' });
    expect(shortReason.status).toBe(400);

    // 改判被拒后业务字段未落（建议态 pending 未被改写、无确认事件）
    const mid = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(mid.intentLevel).toBe('pending');
    expect(
      await prisma.leadEvent.findFirst({
        where: { leadId: lead.id, kind: LEAD_EVENT_KIND.INTENT_CONFIRMED },
      }),
    ).toBeNull();

    // 纯确认（level 缺省沿用 AI 建议，非改判）不带理由仍成功
    const confirmOnly = await request(server)
      .post(`/api/v1/leads/${lead.id}/intent-confirm`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ taskId: task!.id });
    expect(confirmOnly.status).toBe(200);
  });

  it('constraints 含证据口径（2026-08-27 复评修订：成交级信号直接判 high + 弱信号条款）', async () => {
    const lead = await mkLead(owner.id);
    await classify(lead.id, owner.token);

    const submitted = gateway.submitted[0];
    expect(submitted).toBeDefined();
    expect(submitted.taskType).toBe('lead.classify');

    const caliber = String(submitted.constraints.evidenceCaliber);
    expect(caliber).toContain('成交级信号'); // 付定金/明确提车时间/约定到店 → high
    expect(caliber).toContain('high');
    expect(caliber).toContain('不影响等级'); // missingInfo 非空不得降档（复评 o8-02/05 根因）
    expect(caliber).toContain('弱信号'); // 回复速度仍是弱信号
    expect(caliber).toContain('回复速度');
  });
});
