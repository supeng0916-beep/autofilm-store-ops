/** 影子样本回流（阶段三 B2）：影子面板优质样本一键转经验卡建议——确定性拼卡走既有
 * createFromChat 通道（零 AI 成本），照发候选自动列出。 */
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

const password = 'S3cure-Passw0rd!';

describe('影子样本回流经验卡（B2）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let bossToken = '';
  let recorderToken = '';
  const leadIds: string[] = [];
  const evIds: string[] = [];
  const taskIds: string[] = [];
  const knowledgeIds: string[] = [];
  const approvalIds: string[] = [];
  let editedTaskId = '';
  let verbatimTaskId = '';
  let intentLeadId = '';

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const mk = async (role: string) => {
      const username = uniqueUsername('sh');
      const user = await prisma.user.create({
        data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
      });
      const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username, password });
      return (res.body as { accessToken: string }).accessToken;
    };
    bossToken = await mk('boss');
    recorderToken = await mk('recorder'); // 记录员无 ai:cost:view → 403 越权挡板

    // 话术样本 1：人工改写后发送（优质对比样本）
    const lead1 = await prisma.lead.create({
      data: { leadNo: 'L-SH-1', sourceCategory: 'offline', sourcePlatform: 't', stage: 'new' },
    });
    leadIds.push(lead1.id);
    const task1 = await prisma.aiTask.create({
      data: {
        taskType: 'sales.draft_message',
        refType: 'lead',
        refId: lead1.id,
        status: 'done',
        inputSummary: 'sh',
        output: { message: '哥，膜贴好了来看下' },
      },
    });
    taskIds.push(task1.id);
    editedTaskId = task1.id;
    const ev1 = await prisma.leadEvent.create({
      data: {
        leadId: lead1.id,
        kind: 'draft_created',
        content: {
          taskId: task1.id,
          version: 2,
          text: '李哥，您 Model Y 的膜贴好了，明天来取车方便吗',
          source: 'human_edit',
        },
      },
    });
    evIds.push(ev1.id);
    const ev2 = await prisma.leadEvent.create({
      data: { leadId: lead1.id, kind: 'send_recorded', content: { taskId: task1.id } },
    });
    evIds.push(ev2.id);

    // 话术样本 2：照发（无改写 → verbatimCandidates 自动列候选）
    const lead2 = await prisma.lead.create({
      data: { leadNo: 'L-SH-2', sourceCategory: 'offline', sourcePlatform: 't', stage: 'new' },
    });
    leadIds.push(lead2.id);
    const task2 = await prisma.aiTask.create({
      data: {
        taskType: 'sales.draft_message',
        refType: 'lead',
        refId: lead2.id,
        status: 'done',
        inputSummary: 'sh',
        output: { message: '姐，本周到店贴膜送全车镀晶体验' },
      },
    });
    taskIds.push(task2.id);
    verbatimTaskId = task2.id;
    const ev3 = await prisma.leadEvent.create({
      data: { leadId: lead2.id, kind: 'send_recorded', content: { taskId: task2.id } },
    });
    evIds.push(ev3.id);

    // 意向改判样本：AI 判 B、人工终判 A
    const lead3 = await prisma.lead.create({
      data: { leadNo: 'L-SH-3', sourceCategory: 'offline', sourcePlatform: 't', stage: 'new' },
    });
    leadIds.push(lead3.id);
    intentLeadId = lead3.id;
    const ev4 = await prisma.leadEvent.create({
      data: {
        leadId: lead3.id,
        kind: 'intent_confirmed',
        content: { aiLevel: 'B', humanLevel: 'A', overridden: true, reason: '客户已到店实车看膜' },
      },
    });
    evIds.push(ev4.id);
  });
  afterAll(async () => {
    await prisma.approvalItem.deleteMany({ where: { id: { in: approvalIds } } });
    await prisma.knowledgeItem.deleteMany({ where: { id: { in: knowledgeIds } } });
    await prisma.leadEvent.deleteMany({ where: { id: { in: evIds } } });
    await prisma.aiTask.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
    await app.close();
  });

  it('GET /ai/shadow/draft：samples 带 taskId；照发样本自动进 verbatimCandidates', async () => {
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/ai/shadow/draft?days=7')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    const body = res.body as {
      samples: Array<{ taskId: string; leadId: string; similarity: number }>;
      verbatimCandidates: Array<{ taskId: string; leadId: string; original: string }>;
    };
    const edited = body.samples.find((s) => s.taskId === editedTaskId);
    expect(edited?.similarity).toBeLessThan(0.9);
    expect(body.samples.every((s) => typeof s.taskId === 'string' && s.taskId)).toBe(true);
    const cand = body.verbatimCandidates.find((c) => c.taskId === verbatimTaskId);
    expect(cand?.original).toContain('镀晶');
  });

  it('GET /ai/shadow/intent：改判样本带 leadNo 供前端展示', async () => {
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/ai/shadow/intent?days=7')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    const body = res.body as {
      overrideSamples: Array<{ leadId: string; leadNo: string; reason: string | null }>;
    };
    const sample = body.overrideSamples.find((s) => s.leadId === intentLeadId);
    expect(sample?.leadNo).toBe('L-SH-3');
    expect(sample?.reason).toContain('到店');
  });

  it('① POST /ai/shadow/experience（draft）：确定性拼卡落建议态草稿，全文含改写前后', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/ai/shadow/experience')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ scope: 'draft', taskId: editedTaskId })
      .expect(201);
    const item = res.body as {
      id: string;
      kind: string;
      status: string;
      title: string;
      source: string | null;
    };
    expect(item.kind).toBe('sales_method');
    expect(item.status).toBe('draft');
    expect(item.title).toContain('影子样本·话术对比');
    expect(item.source).toContain('影子样本回流');
    knowledgeIds.push(item.id);
    // 落库核对：面板 80 截断仅展示用，卡片 content 为 AI 草稿/人工实发全文 + 相似度三段
    const row = await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.content).toContain('【AI 草稿】');
    expect(row.content).toContain('哥，膜贴好了来看下');
    expect(row.content).toContain('【人工实发】');
    expect(row.content).toContain('李哥，您 Model Y 的膜贴好了，明天来取车方便吗');
    expect(row.content).toContain('【相似度】');
  });

  it('② POST /ai/shadow/experience（intent）：AI 判级/人工判级/改判理由三段落卡', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/ai/shadow/experience')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({
        scope: 'intent',
        leadId: intentLeadId,
        aiLevel: 'B',
        humanLevel: 'A',
        reason: '客户已到店实车看膜',
      })
      .expect(201);
    const item = res.body as {
      id: string;
      kind: string;
      status: string;
      title: string;
      source: string | null;
    };
    expect(item.kind).toBe('sales_method');
    expect(item.status).toBe('draft');
    expect(item.title).toContain('影子样本·意向改判');
    expect(item.source).toContain('影子样本回流');
    knowledgeIds.push(item.id);
    const row = await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.content).toContain('【AI 判级】B');
    expect(row.content).toContain('【人工判级】A');
    expect(row.content).toContain('【改判理由】客户已到店实车看膜');
    expect(row.content).toContain('L-SH-3'); // 客资编号溯源
  });

  it('③ taskId 不存在 → 422', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/ai/shadow/experience')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ scope: 'draft', taskId: 'no-such-task' })
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('④ 记录员（无 ai:cost:view）→ 403', async () => {
    await request(app.getHttpServer() as Server)
      .post('/api/v1/ai/shadow/experience')
      .set('Authorization', `Bearer ${recorderToken}`)
      .send({ scope: 'draft', taskId: editedTaskId })
      .expect(403);
  });

  it('⑤ P3-F03：转卡自动创建 knowledge.activate 审批；老板批准后卡生效（学习闭环）', async () => {
    // 评测实锤：转卡前后待审批均 2 项，「已入知识库待老板审批」在审批中心无法兑现——
    // 修复口径：转卡即建审批单（响应带 approvalId 供前端跳转），批准经既有
    // knowledge.activate handler 自动激活
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/ai/shadow/experience')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ scope: 'draft', taskId: verbatimTaskId })
      .expect(201);
    const item = res.body as { id: string; status: string; approvalId?: string };
    knowledgeIds.push(item.id);
    expect(item.status).toBe('draft');
    expect(item.approvalId).toBeTruthy();

    const approvalId = item.approvalId as string;
    approvalIds.push(approvalId);
    const appr = await prisma.approvalItem.findUniqueOrThrow({ where: { id: approvalId } });
    expect(appr.type).toBe('knowledge.activate');
    expect(appr.status).toBe('pending');
    expect(appr.payload).toMatchObject({ itemId: item.id });
    expect(appr.basis ?? '').toContain('影子样本');

    // 老板批准 → handler executeActivate → 卡 active（审批中心闭环，无需评测脚本代庖）
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/approvals/${approvalId}/approve`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ confirmed: true })
      .expect(201); // Nest POST 默认 201（审批端点未加 @HttpCode(200)）
    const row = await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.status).toBe('active');
  });
});
