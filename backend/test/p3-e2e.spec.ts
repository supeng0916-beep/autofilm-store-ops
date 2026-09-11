import type { INestApplication } from '@nestjs/common';
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
import { scanForLeaks } from '../src/modules/ai-dispatch/masker';
import { AssignService, ASSIGN_META_KEYS } from '../src/modules/lead/assign.service';
import { LEAD_EVENT_KIND } from '../src/modules/lead/lead.constants';
import { SilenceService } from '../src/modules/lead/silence.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { uniqueUsername } from './helpers/unique';
import { buildApp } from './setup';

/** 记录提交载荷并回显三种合法 AI 输出的假网关（lead.summary / sales.draft_message / lead.classify）。
 * 全部输出为「建议/草稿」态：只落 ai_tasks.output，绝不写业务字段、绝无对外发送。 */
class FakeE2eGateway implements OpenClawGateway {
  submitted: SubmitTaskRequest[] = [];

  submit(request: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.submitted.push(request);
    let output: GatewayRunResult['output'];
    if (request.taskType === 'lead.summary') {
      output = {
        summary: '客户关注改色膜品牌与价格，意向中高。',
        concerns: ['价格预算', '施工工期'],
        questionsToAsk: ['是否确定车型颜色？', '是否有到店时间偏好？'],
        nextAction: '预约到店看膜选款',
        visitPitch: '到店可实地看膜片与实车效果',
        escalationHint: '若连续两天未回复，升级店长跟进',
      };
    } else if (request.taskType === 'lead.classify') {
      output = {
        level: 'high',
        confidence: 0.85,
        evidence: ['明确车型需求', '主动问价'],
        missingInfo: ['到店时间'],
        nextAction: '预约到店看膜',
      };
    } else {
      output = {
        message: '您好，我是AutoFilm Demo的小周，看到您对改色膜有兴趣，方便到店看下色卡吗？',
        notes: '已避开报价，引导到店。',
      };
    }
    return Promise.resolve({ status: 'done', output, model: 'fake' });
  }

  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** 停掉测试 app 的定时任务（SLA 每分钟 / 沉默每小时），避免与手工驱动 tick 竞争 */
function stopCronJobs(app: INestApplication): void {
  for (const job of app.get(SchedulerRegistry).getCronJobs().values()) void job.stop();
}

interface TokenUser {
  id: string;
  username: string;
  token: string;
}

let phoneSeq = 0;
/** 合成电话（S16）：138/139 段 + 时间戳 + 序号，跨测试运行唯一，零真实数据 */
function syntheticPhone(prefix = '138'): string {
  return `${prefix}${String(Date.now()).slice(-6)}${String(phoneSeq++).padStart(2, '0')}`;
}

/** 派发文本（字段字典 §3 行式「键：值」），sourceInfo 决定来源平台 */
function dispatchText(phone: string, dispatchNo: string, sourceInfo = '抖音私信'): string {
  return [
    `派发NO：${dispatchNo}`,
    '门店：AutoFilm Demo',
    '日期：2026-08-14 10:20',
    `信息来源：${sourceInfo}`,
    `电话：${phone}`,
    '车型：凯迪拉克XT5',
    '需求：隐形车衣',
  ].join('\n');
}

describe('P3-08 全链路集成测试（任务书 §8 合成版）', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let auth: AuthService;
  let silence: SilenceService;
  let assign: AssignService;
  let gateway: FakeE2eGateway;
  let boss: TokenUser;
  let storeManager: TokenUser;
  let salesA: TokenUser;
  let salesB: TokenUser;
  const password = 'S3cure-Passw0rd!';

  const mkUser = async (role: string): Promise<TokenUser> => {
    const username = uniqueUsername(`p3e2e_${role}`);
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
    const user = await prisma.user.create({
      data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
    const res = await request(server).post('/api/v1/auth/login').send({ username, password });
    return { id: user.id, username, token: (res.body as { accessToken: string }).accessToken };
  };

  const importDispatch = async (rawTexts: string[], token: string) => {
    const res = await request(server)
      .post('/api/v1/leads/import/dispatch')
      .set('Authorization', `Bearer ${token}`)
      .send({ rawTexts });
    expect(res.status).toBe(200);
    return res.body as { batchId: string; created: number; dupCount: number };
  };

  const leadByDispatchNo = (no: string) =>
    prisma.lead.findFirst({ where: { upstreamDispatchNo: no } });

  const eventKinds = async (leadId: string): Promise<string[]> => {
    const events = await prisma.leadEvent.findMany({
      where: { leadId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    return events.map((e) => e.kind);
  };

  const stage = (id: string, to: string, token: string, reason = '正常推进') =>
    request(server)
      .patch(`/api/v1/leads/${id}/stage`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stage: to, reason });

  beforeAll(async () => {
    gateway = new FakeE2eGateway();
    app = await buildApp(gateway);
    stopCronJobs(app);
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    silence = app.get(SilenceService);
    assign = app.get(AssignService);
    for (const code of ['boss', 'store_manager', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    boss = await mkUser('boss');
    storeManager = await mkUser('store_manager');
    salesA = await mkUser('sales_ops');
    salesB = await mkUser('sales_ops');

    // 分配池：线上池 salesA/salesB 轮询、4S 池店长、老板兜底；游标归零
    await prisma.systemMeta.upsert({
      where: { key: ASSIGN_META_KEYS.onlinePool },
      create: {
        key: ASSIGN_META_KEYS.onlinePool,
        value: JSON.stringify([salesA.username, salesB.username]),
      },
      update: { value: JSON.stringify([salesA.username, salesB.username]) },
    });
    await prisma.systemMeta.upsert({
      where: { key: ASSIGN_META_KEYS.fourSPool },
      create: { key: ASSIGN_META_KEYS.fourSPool, value: JSON.stringify([storeManager.username]) },
      update: { value: JSON.stringify([storeManager.username]) },
    });
    await prisma.systemMeta.upsert({
      where: { key: ASSIGN_META_KEYS.boss },
      create: { key: ASSIGN_META_KEYS.boss, value: boss.username },
      update: { value: boss.username },
    });
    await prisma.systemMeta.upsert({
      where: { key: ASSIGN_META_KEYS.cursor },
      create: { key: ASSIGN_META_KEYS.cursor, value: '0' },
      update: { value: '0' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    gateway.submitted = [];
  });

  it('① 抖音客资全链路：派发解析→分配→首触SLA→沟通→AI摘要/草稿/分级→复制→到店→成交', async () => {
    const phone = syntheticPhone('139');
    const dispatchNo = `D-${Date.now()}`;
    const imported = await importDispatch([dispatchText(phone, dispatchNo)], boss.token);
    expect(imported.created).toBe(1);
    expect(imported.dupCount).toBe(0);

    const lead = await leadByDispatchNo(dispatchNo);
    expect(lead).not.toBeNull();
    const leadId = lead!.id;
    // 分配：线上池轮询命中 salesA 或 salesB，写 assignedAt + assigned 事件
    expect([salesA.id, salesB.id]).toContain(lead!.ownerUserId);
    expect(lead!.assignedAt).not.toBeNull();
    expect(lead!.sourcePlatform).toBe('抖音');
    expect(lead!.sourceCategory).toBe('online');
    const ownerToken = lead!.ownerUserId === salesA.id ? salesA.token : salesB.token;

    // 首触 SLA：新线索活跃、未触达 → 计时中；首触后 → done
    const before = await request(server)
      .get(`/api/v1/leads/${leadId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(before.status).toBe(200);
    expect((before.body as { sla: { state: string } }).sla.state).toBe('ok');

    const attempt = await request(server)
      .post(`/api/v1/leads/${leadId}/contact-attempt`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(attempt.status).toBe(200);

    const afterContact = await request(server)
      .get(`/api/v1/leads/${leadId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect((afterContact.body as { sla: { state: string } }).sla.state).toBe('done');

    // 沟通：客户回复 → 首次回复时间戳 + 自动触发意向分级
    const reply = await request(server)
      .post(`/api/v1/leads/${leadId}/customer-reply`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(reply.status).toBe(200);

    // AI 摘要：分配后自动触发，输出为建议态（GET 状态视图 {status, summary}，不写业务字段）
    const summary = await request(server)
      .get(`/api/v1/leads/${leadId}/ai-summary`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(summary.status).toBe(200);
    expect(
      (summary.body as { summary: { summary: string } | null }).summary!.summary.length,
    ).toBeGreaterThan(0);

    // 意向分级：分配与客户回复均已触发，取待确认建议并人工确认
    const proposals = await request(server)
      .get(`/api/v1/leads/${leadId}/intent-proposals`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(proposals.status).toBe(200);
    const proposal = (proposals.body as { proposal: { taskId: string; level: string } | null })
      .proposal;
    expect(proposal).not.toBeNull();
    const confirm = await request(server)
      .post(`/api/v1/leads/${leadId}/intent-confirm`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ taskId: proposal!.taskId });
    expect(confirm.status).toBe(200);

    // 草稿：生成 → 复制（不标已发送）
    const draft = await request(server)
      .post(`/api/v1/leads/${leadId}/drafts`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ goal: '约到店看色卡' });
    expect(draft.status).toBe(200);
    const taskId = (draft.body as { taskId: string }).taskId;

    const copied = await request(server)
      .post(`/api/v1/leads/${leadId}/drafts/${taskId}/copy`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(copied.status).toBe(200);
    // 已复制 ≠ 已发送：无 send_recorded，lastFollowUpResult 不因复制而变
    const persistedAfterCopy = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(persistedAfterCopy.lastFollowUpResult).toBeNull();

    // 到店预约 → 成交
    for (const to of ['contacted', 'communicating', 'visit_booked']) {
      const res = await stage(leadId, to, ownerToken);
      expect(res.status).toBe(200);
    }
    const won = await request(server)
      .post(`/api/v1/leads/${leadId}/won`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ amountFen: 128800, reason: '客户到店确认成交' });
    expect(won.status).toBe(200);

    // 五类时间戳齐全
    const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(persisted.upstreamDispatchAt).not.toBeNull();
    expect(persisted.receivedAt).not.toBeNull();
    expect(persisted.assignedAt).not.toBeNull();
    expect(persisted.firstContactAttemptAt).not.toBeNull();
    expect(persisted.firstCustomerReplyAt).not.toBeNull();
    expect(persisted.finalStatus).toBe('won');

    // 事件链快照：8 类事件（dispatched/assigned/intent_confirmed/draft_copied/stage×3/won）
    expect((await eventKinds(leadId)).sort()).toEqual(
      [
        'dispatch_parsed',
        'assigned',
        'intent_confirmed',
        'draft_copied',
        'stage_changed',
        'stage_changed',
        'stage_changed',
        'won',
      ].sort(),
    );
    const stageTos = await prisma.leadEvent.findMany({
      where: { leadId, kind: LEAD_EVENT_KIND.STAGE_CHANGED },
      orderBy: { occurredAt: 'asc' },
    });
    expect(stageTos.map((e) => (e.content as { to: string }).to)).toEqual([
      'contacted',
      'communicating',
      'visit_booked',
    ]);

    // AI 上下文脱敏：summary 任务提交不含电话/微信/chatLink
    const summarySubmit = gateway.submitted.find((s) => s.taskType === 'lead.summary');
    expect(summarySubmit).toBeDefined();
    expect(Object.keys(summarySubmit!.context)).not.toContain('phone');
    expect(Object.keys(summarySubmit!.context)).not.toContain('wechat');
    expect(Object.keys(summarySubmit!.context)).not.toContain('chatLink');
    expect(scanForLeaks(summarySubmit!)).toEqual([]);
  });

  it('② 沉默链至14天提醒→人工确认流失→重开', async () => {
    const t0 = new Date('2026-08-06T08:00:00.000Z');
    const lead = await prisma.lead.create({
      data: {
        leadNo: `L-P3E2E-${Date.now()}-sl`,
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        ownerUserId: salesA.id,
        stage: 'communicating',
        finalStatus: 'active',
        firstCustomerReplyAt: t0,
      },
    });

    await silence.tick(new Date('2026-08-07T09:00:00.000Z')); // +25h → risk
    await silence.tick(new Date('2026-08-09T09:00:00.000Z')); // +73h → follow_due
    await silence.tick(new Date('2026-08-14T09:00:00.000Z')); // +8d → nurture + silence
    await silence.tick(new Date('2026-08-20T09:00:00.000Z')); // +14d → 提醒（不自动判流失）

    let persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(persisted.finalStatus).toBe('silence');
    expect(persisted.silenceStage).toBe('nurture');

    const silenceMarked = await prisma.leadEvent.findMany({
      where: { leadId: lead.id, kind: LEAD_EVENT_KIND.SILENCE_MARKED },
      orderBy: { occurredAt: 'asc' },
    });
    expect(silenceMarked.map((e) => (e.content as { stage: string }).stage)).toEqual([
      'risk',
      'follow_due',
      'nurture',
    ]);
    const remind = await prisma.leadEvent.findMany({
      where: { leadId: lead.id, kind: LEAD_EVENT_KIND.CHURN_REMIND_14D },
    });
    expect(remind).toHaveLength(1);

    // 人工确认流失：负责人建议 → 老板批准 → lost
    const propose = await request(server)
      .post(`/api/v1/leads/${lead.id}/churn-propose`)
      .set('Authorization', `Bearer ${salesA.token}`)
      .send({ reason: 'unreachable' });
    expect(propose.status).toBe(200);
    const approvalId = (propose.body as { approvalId: string }).approvalId;
    expect((propose.body as { finalStatus: string }).finalStatus).toBe('lost_pending');

    const approve = await request(server)
      .post(`/api/v1/approvals/${approvalId}/approve`)
      .set('Authorization', `Bearer ${boss.token}`)
      .send({ confirmed: true });
    expect(approve.status).toBe(201);
    persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(persisted.finalStatus).toBe('lost');
    expect(persisted.closedAt).not.toBeNull();

    // 重开：仅 boss/store_manager，回原 owner，流失记录保留
    const reopen = await request(server)
      .post(`/api/v1/leads/${lead.id}/reopen`)
      .set('Authorization', `Bearer ${boss.token}`)
      .send({ reason: '客户重新联系' });
    expect(reopen.status).toBe(200);
    persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(persisted.finalStatus).toBe('active');
    expect(persisted.ownerUserId).toBe(salesA.id);

    const kinds = await eventKinds(lead.id);
    for (const k of [
      'silence_marked',
      'churn_remind_14d',
      'churn_proposed',
      'churn_decided',
      'reopened',
    ]) {
      expect(kinds).toContain(k);
    }
  });

  it('③ 连续重复派发挂链回放：同联系方式二次导入不删除，dup_linked 关联主客资', async () => {
    const phone = syntheticPhone('139');
    const firstNo = `D-${Date.now()}-a`;
    const secondNo = `D-${Date.now()}-b`;

    const first = await importDispatch([dispatchText(phone, firstNo)], boss.token);
    expect(first.created).toBe(1);
    const primary = await leadByDispatchNo(firstNo);
    expect(primary).not.toBeNull();

    const second = await importDispatch([dispatchText(phone, secondNo)], boss.token);
    expect(second.created).toBe(1);
    expect(second.dupCount).toBe(1);
    const dup = await leadByDispatchNo(secondNo);
    expect(dup).not.toBeNull();

    // 挂链：dup.dupOfLeadId = primary.id；沿用原负责人；两方事件均保留
    expect(dup!.dupOfLeadId).toBe(primary!.id);
    expect(dup!.ownerUserId).toBe(primary!.ownerUserId);
    expect(await eventKinds(dup!.id)).toEqual(
      expect.arrayContaining(['dispatch_parsed', 'dup_linked', 'assigned']),
    );
    // 主客资事件未被删除
    expect(await eventKinds(primary!.id)).toEqual(
      expect.arrayContaining(['dispatch_parsed', 'assigned']),
    );
    expect(await prisma.lead.count({ where: { id: primary!.id } })).toBe(1);
    expect(await prisma.lead.count({ where: { id: dup!.id } })).toBe(1);
  });

  it('④ 到店客资不自动分配，接待人手工认领', async () => {
    const phone = syntheticPhone('138');
    const dispatchNo = `D-${Date.now()}`;
    await importDispatch([dispatchText(phone, dispatchNo, '到店')], boss.token);

    const lead = await leadByDispatchNo(dispatchNo);
    expect(lead).not.toBeNull();
    expect(lead!.ownerUserId).toBeNull();
    expect(lead!.sourcePlatform).toBe('到店');

    const claim = await request(server)
      .post(`/api/v1/leads/${lead!.id}/claim`)
      .set('Authorization', `Bearer ${salesA.token}`)
      .send({});
    expect(claim.status).toBe(200);
    expect((claim.body as { ownerUserId: string }).ownerUserId).toBe(salesA.id);

    const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead!.id } });
    expect(persisted.ownerUserId).toBe(salesA.id);
    expect(await eventKinds(lead!.id)).toEqual(expect.arrayContaining(['claim']));
  });

  it('⑤ 转介绍回原关系维护人（Customer.sourceReferralOwnerId 路由）', async () => {
    const customer = await prisma.customer.create({
      data: { name: '合成·老客', phone: syntheticPhone('139'), sourceReferralOwnerId: salesB.id },
    });
    const lead = await prisma.lead.create({
      data: {
        leadNo: `L-P3E2E-${Date.now()}-ref`,
        sourceCategory: 'offline',
        sourcePlatform: '老客户转介绍',
        customerId: customer.id,
      },
    });
    const result = await assign.route(lead);
    expect(result.ownerUserId).toBe(salesB.id);
    expect(result.reason).toBe('转介绍回原关系维护人');
  });

  it('⑥ 4S 线索店长分配', async () => {
    const phone = syntheticPhone('138');
    const dispatchNo = `D-${Date.now()}`;
    await importDispatch([dispatchText(phone, dispatchNo, '4S店')], boss.token);

    const lead = await leadByDispatchNo(dispatchNo);
    expect(lead).not.toBeNull();
    expect(lead!.sourcePlatform).toBe('4S店');
    expect(lead!.ownerUserId).toBe(storeManager.id);

    const assigned = await prisma.leadEvent.findFirst({
      where: { leadId: lead!.id, kind: LEAD_EVENT_KIND.ASSIGNED },
    });
    expect(assigned).not.toBeNull();
    expect((assigned!.content as { reason: string }).reason).toContain('4S池');
  });

  it('⑦ 未确认分级不影响排序与分配（建议态隔离）', async () => {
    const early = new Date('2099-01-01T00:00:00.000Z');
    const late = new Date('2099-01-02T00:00:00.000Z');
    const leadEarly = await prisma.lead.create({
      data: {
        leadNo: `L-P3E2E-${Date.now()}-early`,
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        ownerUserId: salesA.id,
        receivedAt: early,
      },
    });
    const leadLate = await prisma.lead.create({
      data: {
        leadNo: `L-P3E2E-${Date.now()}-late`,
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        ownerUserId: salesA.id,
        receivedAt: late,
      },
    });

    // 对 leadEarly 触发分级（AI 建议 high），不确认
    const res = await request(server)
      .post(`/api/v1/leads/${leadEarly.id}/classify`)
      .set('Authorization', `Bearer ${salesA.token}`);
    expect(res.status).toBe(200);

    const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: leadEarly.id } });
    expect(persisted.intentLevel).toBe('pending');
    expect(persisted.intentConfirmedBy).toBeNull();

    // 队列仍按 receivedAt desc 排序，未确认分级不插队
    const list = await request(server)
      .get('/api/v1/leads')
      .set('Authorization', `Bearer ${salesA.token}`);
    expect(list.status).toBe(200);
    const items = list.body as Array<{ id: string; intentLevel: string }>;
    const ids = items.map((l) => l.id);
    expect(ids.indexOf(leadLate.id)).toBeLessThan(ids.indexOf(leadEarly.id));
    expect(items.find((l) => l.id === leadEarly.id)!.intentLevel).toBe('pending');
  });

  it('⑧ 全程审计可回溯：导入/分配/阶段/成交均留痕，时间线有序', async () => {
    const phone = syntheticPhone('138');
    const dispatchNo = `D-${Date.now()}`;
    const imported = await importDispatch([dispatchText(phone, dispatchNo)], boss.token);
    const lead = await leadByDispatchNo(dispatchNo);
    expect(lead).not.toBeNull();
    const leadId = lead!.id;

    // 手动改派（写 lead.assigned 审计）——2026-08-27 起 assign 幂等：同人改派 no-op，
    // 故必须派给与自动路由结果不同的销售（否则不产生 assigned 审计，这正是幂等语义）
    const other = lead!.ownerUserId === salesA.id ? salesB : salesA;
    const reassign = await request(server)
      .patch(`/api/v1/leads/${leadId}/assign`)
      .set('Authorization', `Bearer ${boss.token}`)
      .send({ ownerUserId: other.id, reason: '调整为另一位跟单' });
    expect(reassign.status).toBe(200);

    for (const to of ['contacted', 'communicating', 'visit_booked']) {
      const res = await stage(leadId, to, other.token);
      expect(res.status).toBe(200);
    }
    const won = await request(server)
      .post(`/api/v1/leads/${leadId}/won`)
      .set('Authorization', `Bearer ${other.token}`)
      .send({ amountFen: 9200, reason: '到店成交' });
    expect(won.status).toBe(200);

    // 审计日志：lead 域三动作 + 导入批次动作
    const leadAudit = await prisma.auditLog.findMany({
      where: { objectType: 'lead', objectId: leadId },
      orderBy: { createdAt: 'asc' },
    });
    expect(leadAudit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['lead.assigned', 'lead.stage_changed', 'lead.won']),
    );
    const batchAudit = await prisma.auditLog.findMany({
      where: { objectType: 'import_batch', objectId: imported.batchId },
    });
    expect(batchAudit.map((a) => a.action)).toContain('lead.import.dispatch');

    // 事件时间线有序（非降序）
    const events = await prisma.leadEvent.findMany({
      where: { leadId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    for (let i = 1; i < events.length; i++) {
      expect(events[i].occurredAt.getTime()).toBeGreaterThanOrEqual(
        events[i - 1].occurredAt.getTime(),
      );
    }
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(['won']));
  });
});
