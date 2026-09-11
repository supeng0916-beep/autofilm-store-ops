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
import { LEAD_EVENT_KIND } from '../src/modules/lead/lead.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

/** 记录提交载荷并回显合法 sales.draft_message 输出的假网关（P2 同款手法） */
class FakeDraftGateway implements OpenClawGateway {
  submitted: SubmitTaskRequest[] = [];
  output: GatewayRunResult['output'] = {
    message: '您好，我是AutoFilm Demo的小周，看到您对改色膜有兴趣，方便到店看下色卡吗？',
    notes: '已避开报价，引导到店。',
  };

  /** 连续 N 次 submit 回「会触发校验降级的输出」（无 message 键 → normalize 后 schema 拒收
   * → 任务 degraded；用完自动归零）。同步网关不会直接回 degraded——降级由回调校验产生。 */
  degradedTimes = 0;

  submit(request: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.submitted.push(request);
    if (this.degradedTimes > 0) {
      this.degradedTimes -= 1;
      return Promise.resolve({ status: 'done', output: { unrelated: true }, model: 'fake' });
    }
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

describe('sales.draft_message（P3-06）', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let auth: AuthService;
  let gateway: FakeDraftGateway;
  let owner: TokenUser;
  const password = 'S3cure-Passw0rd!';
  let leadSeq = 0;

  const mkUser = async (role: string): Promise<TokenUser> => {
    const username = uniqueUsername(`sd_${role}`);
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
        leadNo: `L-SD-${Date.now()}-${++leadSeq}`,
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        ownerUserId,
        ...extra,
      },
    });

  const draftTaskOf = (leadId: string) =>
    prisma.aiTask.findFirst({
      where: { refType: 'lead', refId: leadId, taskType: 'sales.draft_message' },
    });

  const submitDraft = (leadId: string, token: string, body: Record<string, unknown> = {}) =>
    request(server)
      .post(`/api/v1/leads/${leadId}/drafts`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  beforeAll(async () => {
    gateway = new FakeDraftGateway();
    app = await buildApp(gateway);
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
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

  it('POST /leads/:id/drafts 提交草稿任务，output 落建议态', async () => {
    const lead = await mkLead(owner.id);
    const res = await submitDraft(lead.id, owner.token, { goal: '约到店看色卡' });
    expect(res.status).toBe(200);
    const body = res.body as { status: string; message: string; notes: string | null };
    expect(body.status).toBe('done');
    expect(body.message).toContain('AutoFilm Demo');
    expect(body.notes).toBe('已避开报价，引导到店。');

    const task = await draftTaskOf(lead.id);
    expect(task).not.toBeNull();
    expect(task!.status).toBe('done');
    expect(task!.refType).toBe('lead');
    expect(task!.refId).toBe(lead.id);
    const output = task!.output as { message: string };
    expect(output.message.length).toBeGreaterThan(0);

    // 建议态：AI 输出只落 ai_tasks.output，业务字段（nextStep/lastFollowUpResult 等）不变
    const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(persisted.nextStep).toBeNull();
    expect(persisted.lastFollowUpResult).toBeNull();
  });

  it('人工编辑不覆盖 AI 原建议：ai_tasks.output 不变，编辑存 draft_created 事件', async () => {
    const lead = await mkLead(owner.id);
    await submitDraft(lead.id, owner.token);
    const task = await draftTaskOf(lead.id);
    expect(task).not.toBeNull();
    const originalOutput = task!.output;

    const res = await request(server)
      .patch(`/api/v1/leads/${lead.id}/drafts/${task!.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ text: '（人工改写）张先生您好，改色膜颜色选好了吗，方便约个时间吗？' });
    expect(res.status).toBe(200);
    const edited = res.body as { taskId: string; version: number; source: string; text: string };
    expect(edited.taskId).toBe(task!.id);
    expect(edited.version).toBe(1);
    expect(edited.source).toBe('human_edit');
    expect(edited.text).toContain('人工改写');

    // AI 原建议原样保留，未被人工编辑覆盖
    const after = await prisma.aiTask.findUniqueOrThrow({ where: { id: task!.id } });
    expect(after.output).toEqual(originalOutput);

    const evt = await prisma.leadEvent.findFirst({
      where: { leadId: lead.id, kind: LEAD_EVENT_KIND.DRAFT_CREATED },
    });
    expect(evt).not.toBeNull();
    expect(evt!.operatorId).toBe(owner.id);
  });

  it('一键复制仅写 draft_copied：查询该 lead 不存在 send_recorded 事件', async () => {
    const lead = await mkLead(owner.id);
    await submitDraft(lead.id, owner.token);
    const task = await draftTaskOf(lead.id);

    const res = await request(server)
      .post(`/api/v1/leads/${lead.id}/drafts/${task!.id}/copy`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send();
    expect(res.status).toBe(200);

    const copied = await prisma.leadEvent.findFirst({
      where: { leadId: lead.id, kind: LEAD_EVENT_KIND.DRAFT_COPIED },
    });
    expect(copied).not.toBeNull();

    // 已复制 ≠ 已发送：复制不产生 send_recorded，也不更新 lastFollowUpResult
    const sent = await prisma.leadEvent.findFirst({
      where: { leadId: lead.id, kind: LEAD_EVENT_KIND.SEND_RECORDED },
    });
    expect(sent).toBeNull();
    const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(persisted.lastFollowUpResult).toBeNull();
  });

  it('send-record 缺证据 422；带证据写 send_recorded 且四段事件分明', async () => {
    const lead = await mkLead(owner.id);
    await submitDraft(lead.id, owner.token);
    const task = await draftTaskOf(lead.id);

    // 缺证据（<10 字）→ 校验失败（ZodValidationPipe 约定 [400,422]，同 approval/lead-lifecycle 约定）
    const bad = await request(server)
      .post(`/api/v1/leads/${lead.id}/drafts/${task!.id}/send-record`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ sendEvidence: '已发送' });
    expect([400, 422]).toContain(bad.status);
    expect((bad.body as { code: string }).code).toBe('VALIDATION_FAILED');

    // 复制 → 发送（带证据）→ 结果，四件事分离留痕
    await request(server)
      .post(`/api/v1/leads/${lead.id}/drafts/${task!.id}/copy`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send();
    const evidence = '已微信发送：您好，看到您对改色膜有兴趣，方便到店看色卡吗？';
    const ok = await request(server)
      .post(`/api/v1/leads/${lead.id}/drafts/${task!.id}/send-record`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ sendEvidence: evidence });
    expect(ok.status).toBe(200);

    const sent = await prisma.leadEvent.findFirst({
      where: { leadId: lead.id, kind: LEAD_EVENT_KIND.SEND_RECORDED },
    });
    expect(sent).not.toBeNull();
    expect((sent!.content as { sendEvidence: string }).sendEvidence).toBe(evidence);

    // 四段分明：AI 建议（ai_tasks.output）/ 复制（draft_copied）/ 发送（send_recorded）/ 结果（lastFollowUpResult）
    const [copied, aiTask] = await Promise.all([
      prisma.leadEvent.findFirst({
        where: { leadId: lead.id, kind: LEAD_EVENT_KIND.DRAFT_COPIED },
      }),
      draftTaskOf(lead.id),
    ]);
    expect(copied).not.toBeNull();
    const aiOutput = aiTask!.output as { message: string };
    expect(aiOutput.message.length).toBeGreaterThan(0);
    const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(persisted.lastFollowUpResult).toBe(evidence);
  });

  it('sales_ops 只能操作本人客资草稿；草稿无对外出口', async () => {
    const other = await mkUser('sales_ops');
    const lead = await mkLead(owner.id);
    await submitDraft(lead.id, owner.token);
    const task = await draftTaskOf(lead.id);

    // 非负责人改写 → 403 LEAD_NOT_OWNER
    const res = await request(server)
      .patch(`/api/v1/leads/${lead.id}/drafts/${task!.id}`)
      .set('Authorization', `Bearer ${other.token}`)
      .send({ text: '越权改写' });
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('LEAD_NOT_OWNER');

    // 草稿无对外出口：复制/发送/编辑不产生任何网关提交（仅初始生成走 submitTask）
    gateway.submitted = [];
    await request(server)
      .post(`/api/v1/leads/${lead.id}/drafts/${task!.id}/copy`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send();
    await request(server)
      .post(`/api/v1/leads/${lead.id}/drafts/${task!.id}/send-record`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ sendEvidence: '已微信发送跟进消息，客户回复再约时间' });
    expect(gateway.submitted).toHaveLength(0);
  });

  it('边界提示词约束随 constraints 下发（含禁止报价/冒充条款）且上下文脱敏', async () => {
    const lead = await mkLead(owner.id);
    await submitDraft(lead.id, owner.token, { goal: '报个底价' });

    const submitted = gateway.submitted[0];
    expect(submitted).toBeDefined();
    expect(submitted.taskType).toBe('sales.draft_message');

    const boundary = String(submitted.constraints.boundary);
    expect(boundary).toContain('冒充');
    expect(boundary).toContain('报价');
    expect(boundary).toContain('金额');
    expect(boundary).toContain('承诺');
    expect(boundary).toContain('定金');
    expect(boundary).toContain('引导到店');

    // 上下文只含 refId 假名与业务字段，不含电话/微信/chatLink
    expect(Object.keys(submitted.context)).not.toContain('phone');
    expect(Object.keys(submitted.context)).not.toContain('wechat');
    expect(Object.keys(submitted.context)).not.toContain('chatLink');
    expect(typeof submitted.context.refId).toBe('string');
    expect(scanForLeaks(submitted)).toEqual([]);
  });

  it('偶发降级自动重试一次（2026-08-27 复评）：首次 degraded → 重试成功返回 done 草稿', async () => {
    const lead = await mkLead(owner.id);
    gateway.degradedTimes = 1; // 首次提交回 degraded（空输出）
    const res = await submitDraft(lead.id, owner.token, { goal: '首触话术' });
    const view = res.body as { status: string; message: string | null };
    expect(view.status).toBe('done');
    expect(view.message).toContain('AutoFilm Demo');
    expect(gateway.submitted.length).toBe(2); // 原次 + 重试次
  });

  it('重试仍降级则如实返回 degraded，且不第三次提交（重试上限=1）', async () => {
    const lead = await mkLead(owner.id);
    gateway.degradedTimes = 2; // 原次与重试次都降级
    const res = await submitDraft(lead.id, owner.token, {});
    const view = res.body as { status: string; message: string | null };
    expect(view.status).toBe('degraded');
    expect(view.message).toBeNull();
    expect(gateway.submitted.length).toBe(2); // 恰好两次，无第三次
  });

  /** RF-03（2026-09-09 fixbatch 复验层8实锤）：sales.draft_message 无 postLint 挂账——
   * 英文过程草稿照落 done（cmttlzxd1…）。草稿是对客文本：R1 英文泄漏 + R3 极限词
   * 与营销/chat 同款红线，hard → failed（路由已接 autoRetry，模型知因再答）。 */
  it('RF-03：英文过程草稿 → lint 拦截 failed（cjk-density），不落 done', async () => {
    const lead = await mkLead(owner.id);
    const saved = gateway.output;
    gateway.output = {
      message:
        'Looking at the lead context, I will draft a friendly follow-up message for this customer now.',
    };
    try {
      const res = await submitDraft(lead.id, owner.token, { goal: '英文过程回归' });
      const view = res.body as { status: string; message: string | null };
      expect(view.status).toBe('failed');
      expect(view.message).toBeNull();
      const task = await draftTaskOf(lead.id);
      expect(task!.status).toBe('failed');
      expect(String(task!.errorMessage)).toContain('lint:cjk-density');
    } finally {
      gateway.output = saved;
    }
  });

  it('RF-03：草稿含广告法极限词 → lint 拦截 failed（banned-words，对客文本同红线）', async () => {
    const lead = await mkLead(owner.id);
    const saved = gateway.output;
    gateway.output = { message: '我们是行业第一的贴膜店，绝对值得信赖，欢迎到店。' };
    try {
      const res = await submitDraft(lead.id, owner.token, { goal: '极限词回归' });
      const view = res.body as { status: string };
      expect(view.status).toBe('failed');
      const task = await draftTaskOf(lead.id);
      expect(String(task!.errorMessage)).toContain('lint:banned-words');
    } finally {
      gateway.output = saved;
    }
  });
});
