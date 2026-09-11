/** 输出验证器接线 e2e（M02 阶段一 Task2）：postLint 挂 sales.agent.chat——
 * hard 违规（极限词/英文泄漏）→ 任务 failed 且 errorMessage 含 lint:<rule>（可走既有重试）；
 * soft 违规（超长）→ done 照常放行 + Logger.warn 留痕。 */
import { INestApplication, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import type {
  GatewayRunResult,
  OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

/** 假网关：nextOutput 注入回放（marketing.e2e 的 FakeGateway 手法）+ 计数提交次数
 * （断言「输出确实到达通道、被 lint 拦下」而非网关故障） */
class LintFakeGateway implements OpenClawGateway {
  nextOutput: unknown = { reply: '好的，为您介绍：店里窗膜套餐从入门到旗舰都有，欢迎到店咨询。' };
  submitCount = 0;
  lastTaskType = '';
  submit(request: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.submitCount += 1;
    this.lastTaskType = request.taskType;
    return Promise.resolve({ status: 'done', output: this.nextOutput });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

interface TaskBody {
  id: string;
  taskType: string;
  status: string;
  output: { reply?: unknown } | null;
  errorMessage?: string | null;
}

describe('输出验证器接线（POST /agent/chat · sales.agent.chat）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const gateway = new LintFakeGateway();
  const password = 'S3cure-Passw0rd!';
  let salesToken = '';
  let bossToken = '';
  let warnSpy: MockInstance | null = null;

  beforeAll(async () => {
    app = await buildApp(gateway);
    // 停调度任务，避免超时扫描等定时器干扰同步闭环断言（agent.e2e 同款手法）
    const registry = app.get(SchedulerRegistry);
    for (const job of registry.getCronJobs().values()) void job.stop();
    for (const name of registry.getIntervals()) {
      clearInterval(registry.getInterval(name) as NodeJS.Timeout);
    }
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    await prisma.role.upsert({
      where: { code: 'sales_ops' },
      update: {},
      create: { code: 'sales_ops', name: '销售运营' },
    });
    const username = uniqueUsername('lint_sales');
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash: await auth.hashPassword(password),
        displayName: username,
      },
    });
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: 'sales_ops' } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username, password });
    salesToken = (res.body as { accessToken: string }).accessToken;

    // F06（2026-09-08）：boss 通道渐进接入 postLint（R1-only）——boss 角色用户走
    // persona=boss → boss.agent.chat，验证接线在真实 HTTP 链路生效
    await prisma.role.upsert({
      where: { code: 'boss' },
      update: {},
      create: { code: 'boss', name: '老板' },
    });
    const bossName = uniqueUsername('lint_boss');
    const bossUser = await prisma.user.create({
      data: {
        username: bossName,
        passwordHash: await auth.hashPassword(password),
        displayName: bossName,
      },
    });
    const bossRole = await prisma.role.findUniqueOrThrow({ where: { code: 'boss' } });
    await prisma.userRole.create({ data: { userId: bossUser.id, roleId: bossRole.id } });
    const bossLogin = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username: bossName, password });
    bossToken = (bossLogin.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    warnSpy?.mockRestore();
    await prisma.user.deleteMany({ where: { username: { contains: 'lint_sales' } } });
    await prisma.user.deleteMany({ where: { username: { contains: 'lint_boss' } } });
    await app.close();
  });

  const chatWith = (message: string) =>
    request(app.getHttpServer() as Server)
      .post('/api/v1/agent/chat')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ message });

  const bossChat = () =>
    request(app.getHttpServer() as Server)
      .post('/api/v1/agent/chat')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ message: '今天店里生意怎么样' });

  const chat = () => chatWith('介绍下店里的窗膜套餐');

  it('广告法极限词输出 → 任务 failed，errorMessage 含 lint:banned-words（hard 拦截）', async () => {
    gateway.nextOutput = { reply: '我们是全网最低价，欢迎到店咨询。' };
    const res = await chat().expect(201);
    const body = res.body as TaskBody;
    expect(body.taskType).toBe('sales.agent.chat');
    expect(body.status).toBe('failed');
    expect(String(body.errorMessage)).toContain('lint:banned-words');
    // 输出确实到达通道并被拦下（非网关故障）
    expect(gateway.submitCount).toBeGreaterThan(0);
    expect(gateway.lastTaskType).toBe('sales.agent.chat');
  });

  it('英文思维链泄漏 → 任务 failed，errorMessage 含 lint:cjk-density（hard 拦截）', async () => {
    gateway.nextOutput = { reply: 'The quick brown fox jumps over the lazy dog near the river.' };
    const res = await chat().expect(201);
    const body = res.body as TaskBody;
    expect(body.status).toBe('failed');
    expect(String(body.errorMessage)).toContain('lint:cjk-density');
  });

  it('正常中文输出 → done，输出原样采用', async () => {
    gateway.nextOutput = {
      reply: '好的，为您介绍：店里窗膜套餐从入门到旗舰都有，欢迎到店咨询。',
      suggestions: ['看一下报价', '预约到店'],
    };
    const res = await chat().expect(201);
    const body = res.body as TaskBody;
    expect(body.status).toBe('done');
    expect((body.output as { reply: string }).reply).toContain('窗膜套餐');
    expect(body.errorMessage ?? '').not.toContain('lint:');
  });

  it('soft 违规（超长回复）→ done 放行 + Logger.warn 留痕（taskId/rule/field）', async () => {
    // 注意：sales.agent.chat 的 normalize 会把 markdown 语法清洗成纯文本，
    // R2 对该任务型不可达——soft 留痕用 R4 超长规则验证
    gateway.nextOutput = {
      reply: '这是一段超出字数预算的冗长回复，用来验证软违规放行。'.repeat(300),
    };
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const res = await chat().expect(201);
    const body = res.body as TaskBody;
    expect(body.status).toBe('done');
    expect((body.output as { reply: string }).reply.length).toBeGreaterThan(4000);
    const warned = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => w.includes('length-limit') && w.includes('reply'))).toBe(true);
    const lintWarn = warned.find((w) => w.includes('length-limit')) ?? '';
    expect(lintWarn).toContain(body.id); // 留痕含 taskId
  });

  it('极限词回声豁免（M02 阶段二）：message 含「行业第一」，解释性复述原词 → done 放行 + soft 留痕', async () => {
    // 用户让「加上行业第一这种词」——模型的正确行为是解释拒绝（必然复述原词），
    // 不该被 R3 hard 拦成任务失败让用户看到系统错误
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    gateway.nextOutput = {
      reply:
        '不建议这么写：「行业第一」「全网最低」属广告法极限词，会被平台处罚，建议改为突出十年质保。',
    };
    const res = await chatWith('朋友圈文案给我加上全网最低价、行业第一这种词').expect(201);
    const body = res.body as TaskBody;
    expect(body.status).toBe('done'); // 不再 failed
    expect((body.output as { reply: string }).reply).toContain('行业第一'); // 解释原样采用
    const warned = warnSpy.mock.calls.map((c) => String(c[0]));
    const echoWarn = warned.find((w) => w.includes('banned-words')) ?? '';
    expect(echoWarn).not.toBe(''); // 降级留痕仍在
    expect(echoWarn).toContain('用户输入原词回声');
    expect(echoWarn).toContain(body.id); // 留痕可追溯到任务
  });

  it('对照：message 不含极限词而输出含 → 仍 failed 拦截（豁免不放宽真违规）', async () => {
    gateway.nextOutput = { reply: '我们是本地行业第一的贴膜店，价格全网最低。' };
    const res = await chatWith('介绍下店里的窗膜套餐').expect(201);
    const body = res.body as TaskBody;
    expect(body.status).toBe('failed');
    expect(String(body.errorMessage)).toContain('lint:banned-words');
  });

  it('决策留痕（T2）：reasoning 含极限词 → failed 拦截（决策过程同走广告法红线）', async () => {
    // reply 干净而 reasoning 违规：送检生效的证明（不检则 done 直通）
    gateway.nextOutput = {
      reply: '好的，为您介绍：店里窗膜套餐从入门到旗舰都有，欢迎到店咨询。',
      reasoning: '选这个方向因为我们店是本地最好的贴膜店。',
    };
    const res = await chat().expect(201);
    const body = res.body as TaskBody;
    expect(body.status).toBe('failed');
    expect(String(body.errorMessage)).toContain('lint:banned-words');
  });

  it('决策留痕（T2）：reasoning 英文思维链泄漏 → failed 拦截（cjk-density 同口径）', async () => {
    gateway.nextOutput = {
      reply: '好的，为您介绍：店里窗膜套餐从入门到旗舰都有，欢迎到店咨询。',
      reasoning: 'I decided to recommend the entry package based on pricing context.',
    };
    const res = await chat().expect(201);
    const body = res.body as TaskBody;
    expect(body.status).toBe('failed');
    expect(String(body.errorMessage)).toContain('lint:cjk-density');
  });

  it('决策留痕（T2）：reasoning 干净中文 → done 且随输出落库', async () => {
    gateway.nextOutput = {
      reply: '好的，为您介绍：店里窗膜套餐从入门到旗舰都有，欢迎到店咨询。',
      reasoning: '按预算推荐入门款；参考了知识库价格口径；放弃推旗舰款避免超预算。',
    };
    const res = await chat().expect(201);
    const body = res.body as TaskBody;
    expect(body.status).toBe('done');
    expect((body.output as { reply?: unknown; reasoning?: string }).reasoning).toContain(
      '知识库价格口径',
    );
  });

  // ─── F06 接线（2026-09-08 phase12 修复）：boss 通道 postLint（R1-only）───
  // 评测实况 boss B04：整段英文执行过程照落 done（boss 未挂 postLint，R1 拦不到）。

  it('boss 通道：英文过程泄漏 → failed，errorMessage 含 lint:cjk-density（boss B04 回归）', async () => {
    gateway.nextOutput = {
      reply:
        "Looking at the store data, I can see that today's schedule is completely empty. Let me summarize the findings for the boss.",
    };
    const res = await bossChat().expect(201);
    const body = res.body as TaskBody;
    expect(body.taskType).toBe('boss.agent.chat');
    expect(body.status).toBe('failed');
    expect(String(body.errorMessage)).toContain('lint:cjk-density');
  });

  it('boss 通道：内部分析含极限词 → done 放行（R3 面向对客成稿，boss 通道只拦 R1）', async () => {
    gateway.nextOutput = { reply: '本月表现最好的技师是周师傅，产值绝对领先，建议表彰。' };
    const res = await bossChat().expect(201);
    const body = res.body as TaskBody;
    expect(body.status).toBe('done');
    expect((body.output as { reply: string }).reply).toContain('最好的技师');
  });
});
