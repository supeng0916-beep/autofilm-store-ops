import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import type {
  GatewayRunResult,
  OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import { scanForLeaks } from '../src/modules/ai-dispatch/masker';
import { LeadSummaryTrigger } from '../src/modules/lead/ai/lead-summary.trigger';
import { AssignService, ASSIGN_META_KEYS } from '../src/modules/lead/assign.service';
import { LeadImportService } from '../src/modules/lead/lead-import.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

/** 记录提交载荷并回显合法输出的假网关（P2 同款手法）。
 * 分配现在同时触发 lead.summary 与 lead.classify（2026-08-26 O8 缺口）——按 taskType 回显各自合法输出。 */
class FakeSummaryGateway implements OpenClawGateway {
  submitted: SubmitTaskRequest[] = [];
  output: GatewayRunResult['output'] = {
    summary: '客户关注贴膜品牌与价格，意向中高。',
    concerns: ['价格预算', '施工工期'],
    questionsToAsk: ['是否确定车型颜色？', '是否有到店时间偏好？'],
    nextAction: '预约到店看膜选款',
    visitPitch: '到店可实地看膜片与实车效果',
    escalationHint: '若客户连续两天未回复，升级店长跟进',
  };
  classifyOutput: GatewayRunResult['output'] = {
    level: 'mid',
    confidence: 0.7,
    evidence: ['主动询问价格与工期'],
    missingInfo: [],
    nextAction: '邀约到店看膜',
  };

  submit(request: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.submitted.push(request);
    const output = request.taskType === 'lead.classify' ? this.classifyOutput : this.output;
    return Promise.resolve({ status: 'done', output, model: 'fake' });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

let phoneSeq = 0;
function syntheticPhone(): string {
  return `138${String(Date.now()).slice(-7)}${phoneSeq++ % 10}`;
}
function dispatchText(phone: string, dispatchNo: string): string {
  return [
    `派发NO：${dispatchNo}`,
    '门店：AutoFilm Demo',
    '日期：2026-08-14 10:20',
    '信息来源：抖音私信',
    `电话：${phone}`,
    '车型：凯迪拉克XT5',
    '需求：隐形车衣',
  ].join('\n');
}

describe('lead.summary（P3-05）', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let auth: AuthService;
  let assign: AssignService;
  let trigger: LeadSummaryTrigger;
  let importService: LeadImportService;
  let gateway: FakeSummaryGateway;
  let boss: { id: string; username: string; token: string };
  let owner: { id: string; username: string; token: string };
  const password = 'S3cure-Passw0rd!';
  let leadSeq = 0;

  const mkUser = async (role: string): Promise<{ id: string; username: string; token: string }> => {
    const username = uniqueUsername(`ls_${role}`);
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
    const user = await prisma.user.create({
      data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
    const res = await request(server).post('/api/v1/auth/login').send({ username, password });
    return { id: user.id, username, token: (res.body as { accessToken: string }).accessToken };
  };

  const newLeadNo = () => `L-${Date.now()}-${++leadSeq}`;

  const mkLead = (data: {
    sourcePlatform?: string;
    customerId?: string | null;
    phone?: string | null;
    wechat?: string | null;
    chatLink?: string | null;
    rawNeed?: string | null;
    target?: string | null;
    ownerUserId?: string | null;
  }) =>
    prisma.lead.create({
      data: {
        leadNo: newLeadNo(),
        sourceCategory: 'online',
        sourcePlatform: data.sourcePlatform ?? '抖音',
        customerId: data.customerId ?? null,
        phone: data.phone ?? null,
        wechat: data.wechat ?? null,
        chatLink: data.chatLink ?? null,
        rawNeed: data.rawNeed ?? null,
        target: data.target ?? null,
        ownerUserId: data.ownerUserId ?? null,
      },
    });

  const importDispatch = async (
    rawTexts: string[],
    token: string,
  ): Promise<{ created: number; dupCount: number }> => {
    const res = await request(server)
      .post('/api/v1/leads/import/dispatch')
      .set('Authorization', `Bearer ${token}`)
      .send({ rawTexts });
    expect(res.status).toBe(200);
    return res.body as { created: number; dupCount: number };
  };

  const summaryTaskOf = (leadId: string) =>
    prisma.aiTask.findFirst({
      where: { refType: 'lead', refId: leadId, taskType: 'lead.summary' },
    });

  beforeAll(async () => {
    gateway = new FakeSummaryGateway();
    app = await buildApp(gateway);
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    assign = app.get(AssignService);
    trigger = app.get(LeadSummaryTrigger);
    importService = app.get(LeadImportService);
    for (const code of ['boss', 'store_manager', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    boss = await mkUser('boss');
    owner = await mkUser('sales_ops');
    // 分配池单销售 + 老板兜底：使导入/分配可成功落到 owner（摘要触发前提）
    await prisma.systemMeta.upsert({
      where: { key: ASSIGN_META_KEYS.onlinePool },
      create: { key: ASSIGN_META_KEYS.onlinePool, value: JSON.stringify([owner.username]) },
      update: { value: JSON.stringify([owner.username]) },
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

  it('导入确认后自动提交 lead.summary 任务（ref=lead）', async () => {
    const phone = syntheticPhone();
    const dispatchNo = `D-${Date.now()}`;
    const res = await importDispatch([dispatchText(phone, dispatchNo)], boss.token);
    expect(res.created).toBe(1);

    const lead = await prisma.lead.findFirst({ where: { phone } });
    expect(lead).not.toBeNull();
    const task = await summaryTaskOf(lead!.id);
    expect(task).not.toBeNull();
    expect(task!.status).toBe('done');
    expect(task!.refType).toBe('lead');
    expect(task!.refId).toBe(lead!.id);
  });

  it('assign.route 直接调用不触发摘要（触发已移出事务）', async () => {
    const lead = await mkLead({});
    const result = await assign.route(lead);
    expect(result.ownerUserId).toBe(owner.id);
    const task = await summaryTaskOf(lead.id);
    expect(task).toBeNull();
  });

  it('手动分配（PATCH /leads/:id/assign）触发摘要', async () => {
    const s2 = await mkUser('sales_ops');
    const lead = await mkLead({});
    const res = await request(server)
      .patch(`/api/v1/leads/${lead.id}/assign`)
      .set('Authorization', `Bearer ${boss.token}`)
      .send({ ownerUserId: s2.id, reason: '调整为销售乙跟单' });
    expect(res.status).toBe(200);

    const task = await summaryTaskOf(lead.id);
    expect(task).not.toBeNull();
    expect(task!.status).toBe('done');
  });

  it('摘要触发发生在事务提交后（post-commit 屏障）', async () => {
    let committed = false;
    importService.onPostCommit = () => {
      committed = true;
    };
    const spy = vi.spyOn(trigger, 'onAssigned').mockImplementation(() => {
      // 触发摘要在 commit 之后：此处 committed 必须已置位
      expect(committed).toBe(true);
      return Promise.resolve();
    });
    try {
      await importDispatch([dispatchText(syntheticPhone(), `D-${Date.now()}`)], boss.token);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      importService.onPostCommit = undefined;
    }
  });

  it('去重路径（同联系方式二次导入）summary 的 refId 走 customerRef 而非 lead.id', async () => {
    const phone = syntheticPhone();
    const first = await importDispatch([dispatchText(phone, `D-${Date.now()}-a`)], boss.token);
    expect(first.created).toBe(1);
    expect(first.dupCount).toBe(0);
    const second = await importDispatch([dispatchText(phone, `D-${Date.now()}-b`)], boss.token);
    expect(second.created).toBe(1);
    expect(second.dupCount).toBe(1);

    const leads = await prisma.lead.findMany({ where: { phone }, orderBy: { createdAt: 'asc' } });
    expect(leads).toHaveLength(2);
    const [primary, dup] = leads;
    expect(primary.customerId).not.toBeNull();
    expect(dup.customerId).toBe(primary.customerId);

    // 二次导入（dup）的摘要 refId 必须是 customerRef 假名，而非 dup.id（Fix round 1 Finding 2）
    const dupTask = await summaryTaskOf(dup.id);
    expect(dupTask).not.toBeNull();
    const ctx = JSON.parse(dupTask!.inputSummary) as { refId: string };
    expect(ctx.refId).toMatch(/^ref_/);
    expect(ctx.refId).not.toBe(dup.id);
    const ref = await prisma.customerRefId.findUniqueOrThrow({
      where: { customerId: primary.customerId! },
    });
    expect(ctx.refId).toBe(ref.refId);
  });

  it('幂等：同一 lead 重复分配事件不产生第二条未终态任务', async () => {
    const lead = await mkLead({});
    // 模拟首次分配已产生一条在途（非终态）任务
    await prisma.aiTask.create({
      data: { taskType: 'lead.summary', refType: 'lead', refId: lead.id, inputSummary: '{}' },
    });

    await trigger.onAssigned(lead);

    const tasks = await prisma.aiTask.findMany({
      where: { refType: 'lead', refId: lead.id, taskType: 'lead.summary' },
    });
    expect(tasks).toHaveLength(1);
  });

  it('提交上下文经脱敏：不含电话/微信/chatLink，客户以 refId 出现', async () => {
    const customer = await prisma.customer.create({
      data: { name: '张先生', phone: '13800138000', wechat: 'wxid-abc123' },
    });
    const lead = await mkLead({
      customerId: customer.id,
      phone: '13800138000',
      wechat: 'wxid-abc123',
      chatLink: 'https://chat.example.com/secret',
      rawNeed: '想贴改色膜，微信联系 13800138000',
    });

    await trigger.onAssigned(lead);

    const submitted = gateway.submitted[0];
    const ctx = submitted.context;
    // 不含敏感键
    expect(Object.keys(ctx)).not.toContain('phone');
    expect(Object.keys(ctx)).not.toContain('wechat');
    expect(Object.keys(ctx)).not.toContain('chatLink');
    // 客户以 refId 假名出现（非 customerId/name）
    expect(typeof ctx.refId).toBe('string');
    expect(ctx.refId).not.toBe(customer.id);
    // 通道边界 maskDeep 双保险：提交载荷整体无明文敏感信息（含 rawNeed 自由文本）
    expect(scanForLeaks(submitted)).toEqual([]);
    expect(JSON.stringify(ctx)).not.toContain('13800138000');
    expect(JSON.stringify(ctx)).not.toContain('wxid-abc123');
    expect(JSON.stringify(ctx)).not.toContain('chat.example.com');
  });

  it('自由文本微信号（wxid/「微信号」标签）经 maskDeep 打码：提交载荷与 inputSummary 均不含微信号', async () => {
    const lead = await prisma.lead.create({
      data: {
        leadNo: newLeadNo(),
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        ownerUserId: owner.id,
        rawNeed: '客户想贴改色膜，新微信 wxid-secret99，可加微信号 abcde12345 联系',
        lastFollowUpResult: '已微信沟通，wxid_zhangsan 表示周末到店看膜',
        target: '凯迪拉克XT5',
      },
    });

    await trigger.onAssigned(lead);

    const task = await summaryTaskOf(lead.id);
    expect(task).not.toBeNull();
    const submitted = gateway.submitted[0];
    const raw = JSON.stringify(submitted.context);
    expect(raw).not.toContain('wxid-secret99');
    expect(raw).not.toContain('wxid_zhangsan');
    expect(raw).not.toContain('abcde12345');
    expect(raw).toContain('凯迪拉克XT5');
    expect(scanForLeaks(submitted)).toEqual([]);

    const inputSummary = JSON.parse(task!.inputSummary) as Record<string, unknown>;
    const inputRaw = JSON.stringify(inputSummary);
    expect(inputRaw).not.toContain('wxid-secret99');
    expect(inputRaw).not.toContain('wxid_zhangsan');
    expect(inputRaw).not.toContain('abcde12345');
  });

  it('输出经 Zod 校验落 ai_tasks.output；GET /leads/:id/ai-summary 返回建议态摘要', async () => {
    const lead = await mkLead({ ownerUserId: owner.id });

    await trigger.onAssigned(lead);

    const task = await summaryTaskOf(lead.id);
    expect(task).not.toBeNull();
    expect(task!.status).toBe('done');
    expect(task!.output).toMatchObject({ summary: '客户关注贴膜品牌与价格，意向中高。' });

    const res = await request(server)
      .get(`/api/v1/leads/${lead.id}/ai-summary`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    // 2026-08-26 O8 缺口：状态视图 { status, summary }——done 时附带完整建议态摘要
    expect((res.body as { status: string }).status).toBe('done');
    const view = (
      res.body as { summary: { summary: string; concerns: string[]; nextAction: string } }
    ).summary;
    expect(view.summary).toContain('意向中高');
    expect(view.concerns).toEqual(['价格预算', '施工工期']);
    expect(view.nextAction).toBe('预约到店看膜选款');
  });

  it('员工标记采用/拒绝写 ai_task_feedback（POST /leads/:id/ai-summary/feedback）', async () => {
    const lead = await mkLead({ ownerUserId: owner.id });
    await trigger.onAssigned(lead);
    const task = await summaryTaskOf(lead.id);
    expect(task).not.toBeNull();

    const res = await request(server)
      .post(`/api/v1/leads/${lead.id}/ai-summary/feedback`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ decision: 'rejected', note: '客户已离店，无需再跟进' });
    expect(res.status).toBe(200);

    const fb = await prisma.aiTaskFeedback.findFirst({ where: { taskId: task!.id } });
    expect(fb).not.toBeNull();
    expect(fb!.decision).toBe('rejected');
    expect(fb!.note).toBe('客户已离店，无需再跟进');
    expect(fb!.userId).toBe(owner.id);

    // 2026-08-25 回显：GET 摘要附带最近一次反馈（老板反馈「按钮无反应」——详情页需展示状态）
    const after = await request(server)
      .get(`/api/v1/leads/${lead.id}/ai-summary`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    const body = after.body as {
      summary?: { feedback?: { decision: string; note: string | null } };
    };
    expect(body.summary?.feedback?.decision).toBe('rejected');
    expect(body.summary?.feedback?.note).toBe('客户已离店，无需再跟进');
  });

  it('sales_ops 不能读/写他人客资的 AI 摘要与反馈（数据范围强制，LEAD_NOT_OWNER）', async () => {
    const other = await mkUser('sales_ops');
    const lead = await prisma.lead.create({
      data: {
        leadNo: newLeadNo(),
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        ownerUserId: owner.id,
      },
    });
    await trigger.onAssigned(lead);
    const task = await summaryTaskOf(lead.id);
    expect(task).not.toBeNull();
    expect(task!.status).toBe('done');

    // 他人读摘要 → 403 LEAD_NOT_OWNER
    const getRes = await request(server)
      .get(`/api/v1/leads/${lead.id}/ai-summary`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(getRes.status).toBe(403);
    expect((getRes.body as { code: string }).code).toBe('LEAD_NOT_OWNER');

    // 他人对摘要写 feedback → 403 LEAD_NOT_OWNER，且不落任何 feedback
    const postRes = await request(server)
      .post(`/api/v1/leads/${lead.id}/ai-summary/feedback`)
      .set('Authorization', `Bearer ${other.token}`)
      .send({ decision: 'adopted', note: '越权反馈' });
    expect(postRes.status).toBe(403);
    expect((postRes.body as { code: string }).code).toBe('LEAD_NOT_OWNER');
    expect(await prisma.aiTaskFeedback.count({ where: { taskId: task!.id } })).toBe(0);
  });

  it('skill 开关关闭时提交被门禁拒（AI_DISABLED）且不产生脏数据', async () => {
    await prisma.systemMeta.upsert({
      where: { key: 'ai.skill.lead.summary.enabled' },
      create: { key: 'ai.skill.lead.summary.enabled', value: 'false' },
      update: { value: 'false' },
    });
    try {
      const lead = await mkLead({});
      await expect(trigger.onAssigned(lead)).rejects.toMatchObject({ code: 'AI_DISABLED' });
      const task = await summaryTaskOf(lead.id);
      expect(task).toBeNull();
    } finally {
      await prisma.systemMeta.deleteMany({ where: { key: 'ai.skill.lead.summary.enabled' } });
    }
  });

  it('skill 关闭时导入仍成功（摘要门禁拒收不阻断导入）', async () => {
    await prisma.systemMeta.upsert({
      where: { key: 'ai.skill.lead.summary.enabled' },
      create: { key: 'ai.skill.lead.summary.enabled', value: 'false' },
      update: { value: 'false' },
    });
    try {
      const phone = syntheticPhone();
      const res = await importDispatch([dispatchText(phone, `D-${Date.now()}`)], boss.token);
      expect(res.created).toBe(1);
      const lead = await prisma.lead.findFirst({ where: { phone } });
      expect(lead).not.toBeNull();
      const task = await summaryTaskOf(lead!.id);
      expect(task).toBeNull();
    } finally {
      await prisma.systemMeta.deleteMany({ where: { key: 'ai.skill.lead.summary.enabled' } });
    }
  });

  // ── 2026-08-26 O8 评测缺口修复：分配即触发首次意向分级 + 状态视图 + 手动重提 ──

  it('导入确认后同时提交 lead.classify 任务（分配即首次分级，不等客户回复）', async () => {
    const phone = syntheticPhone();
    const res = await importDispatch([dispatchText(phone, `D-${Date.now()}`)], boss.token);
    expect(res.created).toBe(1);
    const lead = await prisma.lead.findFirst({ where: { phone } });
    expect(lead).not.toBeNull();
    const task = await prisma.aiTask.findFirst({
      where: { refType: 'lead', refId: lead!.id, taskType: 'lead.classify' },
    });
    expect(task).not.toBeNull();
    expect(task!.status).toBe('done');

    // 意向建议状态视图：done 且带建议内容
    const proposals = await request(server)
      .get(`/api/v1/leads/${lead!.id}/intent-proposals`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(proposals.status).toBe(200);
    expect((proposals.body as { status: string }).status).toBe('done');
    const proposal = (proposals.body as { proposal: { level: string } | null }).proposal;
    expect(proposal).not.toBeNull();
    expect(proposal!.level).toBe('mid');
  });

  it('GET /leads/:id/ai-summary 状态视图：无任务 → none；有在途任务 → pending（详情页轮询依据）', async () => {
    // none：从未生成
    const leadNone = await mkLead({ ownerUserId: owner.id });
    const resNone = await request(server)
      .get(`/api/v1/leads/${leadNone.id}/ai-summary`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(resNone.body).toEqual({ status: 'none', summary: null });

    // pending：手动造一条在途任务（不进网关，保持非终态）
    const leadPending = await mkLead({ ownerUserId: owner.id });
    await prisma.aiTask.create({
      data: {
        taskType: 'lead.summary',
        refType: 'lead',
        refId: leadPending.id,
        inputSummary: '{}',
      },
    });
    const resPending = await request(server)
      .get(`/api/v1/leads/${leadPending.id}/ai-summary`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(resPending.body).toEqual({ status: 'pending', summary: null });
  });

  it('最新一次 degraded 时 GET 仍回旧 done 摘要且 status=degraded（旧建议不因重试失败丢失）', async () => {
    const lead = await mkLead({ ownerUserId: owner.id });
    await trigger.onAssigned(lead); // 第一条 done
    const first = await summaryTaskOf(lead.id);
    expect(first!.status).toBe('done');
    // 手动造一条更晚的 degraded（模拟重提后校验失败——O8 o8-01 实况）
    await prisma.aiTask.create({
      data: {
        taskType: 'lead.summary',
        refType: 'lead',
        refId: lead.id,
        inputSummary: '{}',
        status: 'degraded',
      },
    });
    const res = await request(server)
      .get(`/api/v1/leads/${lead.id}/ai-summary`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect((res.body as { status: string }).status).toBe('degraded');
    const view = (res.body as { summary: { taskId: string } | null }).summary;
    expect(view).not.toBeNull();
    expect(view!.taskId).toBe(first!.id);
  });

  it('POST /leads/:id/ai-summary/regenerate：无任务新建、非终态幂等、终态后可重提；他人客资 403', async () => {
    const other = await mkUser('sales_ops');
    const lead = await mkLead({ ownerUserId: owner.id });

    // 他人 regenerate → 403 LEAD_NOT_OWNER
    const forbidden = await request(server)
      .post(`/api/v1/leads/${lead.id}/ai-summary/regenerate`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(forbidden.status).toBe(403);
    expect((forbidden.body as { code: string }).code).toBe('LEAD_NOT_OWNER');

    // 无任务 → 新建并完成
    const first = await request(server)
      .post(`/api/v1/leads/${lead.id}/ai-summary/regenerate`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    const firstTaskId = (first.body as { taskId: string }).taskId;
    expect(
      await prisma.aiTask.count({
        where: { refType: 'lead', refId: lead.id, taskType: 'lead.summary' },
      }),
    ).toBe(1);

    // 非终态在途 → 幂等返回既有 taskId，不新增
    await prisma.aiTask.create({
      data: { taskType: 'lead.summary', refType: 'lead', refId: lead.id, inputSummary: '{}' },
    });
    const inFlight = await request(server)
      .post(`/api/v1/leads/${lead.id}/ai-summary/regenerate`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect((inFlight.body as { taskId: string }).taskId).not.toBe(firstTaskId); // 返回在途那条
    expect(
      await prisma.aiTask.count({
        where: { refType: 'lead', refId: lead.id, taskType: 'lead.summary' },
      }),
    ).toBe(2);

    // 清理在途后（终态化）再重提 → 按当前上下文新建第三条
    await prisma.aiTask.updateMany({
      where: { refType: 'lead', refId: lead.id, taskType: 'lead.summary', status: 'pending' },
      data: { status: 'cancelled' },
    });
    await request(server)
      .post(`/api/v1/leads/${lead.id}/ai-summary/regenerate`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(
      await prisma.aiTask.count({
        where: { refType: 'lead', refId: lead.id, taskType: 'lead.summary' },
      }),
    ).toBe(3);
  });
});
