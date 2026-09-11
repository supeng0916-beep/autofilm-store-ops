import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AiTaskRegistry } from '../src/modules/ai-dispatch/ai-dispatch.registry';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type {
  GatewayRunResult,
  OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

/** 捕获网关：记录提交载荷并回 fake 输出（断言 context 注入与人格路由）。
 * streamReplay（2026-08-26 流式）：非空时 submit 逐段回调 onAssistantText，每段=累计原文快照。 */
class CaptureGateway implements OpenClawGateway {
  submitted: SubmitTaskRequest[] = [];
  output: unknown = { reply: '（fake）好的，话术如下…', suggestions: ['复制话术', '再来一条'] };
  streamReplay: string[] = [];
  failNext = false;
  submit(
    request: SubmitTaskRequest,
    onAssistantText?: (cumulativeText: string) => void,
  ): Promise<GatewayRunResult> {
    this.submitted.push(request);
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('gateway down'));
    }
    if (onAssistantText && this.streamReplay.length > 0) {
      // 网关语义：每段即累计原文快照（data.text 后到覆盖），非增量拼接
      for (const snapshot of this.streamReplay) onAssistantText(snapshot);
    }
    return Promise.resolve({ status: 'done', output: this.output });
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
  output: { reply?: unknown; suggestions?: unknown } | null;
}

/** Agent 对话入口（2026-08-26 销售 Agent V1）：登录即可、人格按角色、知识预检索注入、历史截断。 */
describe('Agent 对话（POST /agent/chat）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const gateway = new CaptureGateway();
  const password = 'S3cure-Passw0rd!';
  const tag = Math.random().toString(36).slice(2, 8);
  let salesToken = '';
  let recorderToken = '';

  const api = (method: 'get' | 'post' | 'patch' | 'delete', url: string, token?: string) => {
    const req = request(app.getHttpServer() as Server)[method](url);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  const mkUser = async (uname: string, role: string): Promise<string> => {
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
    const user = await prisma.user.create({
      data: {
        username: uname,
        passwordHash: await auth.hashPassword(password),
        displayName: uname,
      },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username: uname, password });
    return (res.body as { accessToken: string }).accessToken;
  };

  beforeAll(async () => {
    app = await buildApp(gateway);
    const registry = app.get(SchedulerRegistry);
    for (const job of registry.getCronJobs().values()) void job.stop();
    for (const name of registry.getIntervals()) {
      clearInterval(registry.getInterval(name) as NodeJS.Timeout);
    }
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    salesToken = await mkUser(uniqueUsername('ag_sales'), 'sales_ops');
    recorderToken = await mkUser(uniqueUsername('ag_rec'), 'recorder');
  });

  afterAll(async () => {
    await prisma.knowledgeItem.deleteMany({ where: { title: { contains: tag } } });
    await prisma.asset.deleteMany({ where: { title: { contains: tag } } });
    await prisma.user.deleteMany({ where: { username: { contains: 'ag_' } } });
    await app.close();
  });

  it('匿名 401；sales_ops 对话 → sales 人格提交并同步取回 fake 回复', async () => {
    await api('post', '/api/v1/agent/chat').send({ message: '你好' }).expect(401);

    const res = await api('post', '/api/v1/agent/chat', salesToken)
      .send({ message: '给 Model Y 客户写条首触话术' })
      .expect(201);
    const body = res.body as TaskBody;
    expect(body.taskType).toBe('sales.agent.chat');
    expect(body.status).toBe('done');
    expect((body.output as { reply: string }).reply).toContain('话术');

    const ctx = gateway.submitted[gateway.submitted.length - 1].context;
    expect(ctx.persona).toBe('sales');
    expect(typeof ctx.staff).toBe('string');
    expect(ctx.message).toBe('给 Model Y 客户写条首触话术');
  });

  it('recorder-only 用户 → general 人格', async () => {
    await api('post', '/api/v1/agent/chat', recorderToken)
      .send({ message: '店里有几种窗膜套餐' })
      .expect(201);
    const ctx = gateway.submitted[gateway.submitted.length - 1].context;
    expect(ctx.persona).toBe('general');
  });

  it('history 超 8 条时服务端截断为最近 8 条', async () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `第${i}轮`,
    }));
    await api('post', '/api/v1/agent/chat', salesToken)
      .send({ message: '继续', history })
      .expect(201);
    const ctx = gateway.submitted[gateway.submitted.length - 1].context as {
      history: Array<{ content: string }>;
    };
    expect(ctx.history).toHaveLength(8);
    expect(ctx.history[0].content).toBe('第2轮'); // 丢弃最旧两条
    expect(ctx.history[7].content).toBe('第9轮');
  });

  it('知识预检索：命中 effective 条目则注入 knowledgeContext（含标题与来源）', async () => {
    await prisma.knowledgeItem.create({
      data: {
        kind: 'price',
        title: `${tag}车衣双膜套餐价格`,
        content: '双膜套餐一口价 7600 元起',
        source: '门店知识源',
        status: 'active',
        createdBy: 'test',
      },
    });
    await api('post', '/api/v1/agent/chat', salesToken)
      .send({ message: `${tag}车衣双膜套餐多少钱` })
      .expect(201);
    const ctx = gateway.submitted[gateway.submitted.length - 1].context;
    expect(String(ctx.knowledgeContext)).toContain(tag);
    expect(String(ctx.knowledgeContext)).toContain('门店知识源');
  });

  it('知识预检索排序（2026-08-26 价格问答回归）：标题命中优先——高频词正文噪音挤不掉目标条目', async () => {
    // 场景复刻：正文都含「报价」的噪音条目（updatedAt 更新）+ 标题才是目标的条目。
    // 纯 updatedAt 排序时噪音把目标挤出 top5，AI 拿到无关价格后误答/拒答。
    for (let i = 0; i < 7; i += 1) {
      await prisma.knowledgeItem.create({
        data: {
          kind: 'price',
          title: `${tag}噪音价格条目${i}`,
          content: `${tag}正文含报价二字但与查询无关的条目 ${i}`,
          source: '门店知识源',
          status: 'active',
          createdBy: 'test',
        },
      });
    }
    const target = await prisma.knowledgeItem.create({
      data: {
        kind: 'price',
        title: `${tag}门店窗膜组合报价（实际报价口径）`,
        content: `${tag}窗膜组合：DM04+DM13+DM14=4600 元`,
        source: '门店知识源',
        status: 'active',
        createdBy: 'test',
      },
    });
    await api('post', '/api/v1/agent/chat', salesToken)
      .send({ message: `${tag}窗膜组合报价是多少` })
      .expect(201);
    const ctx = gateway.submitted[gateway.submitted.length - 1].context;
    const contextText = String(ctx.knowledgeContext);
    expect(contextText).toContain(target.title); // 标题命中的目标条目必须在场
    expect(contextText.indexOf(target.title)).toBeLessThan(
      contextText.indexOf(`${tag}噪音价格条目`),
    ); // 且排在噪音前
  });

  it('知识预检索匹配（2026-08-26 价格问答回归）：型号词大小写不敏感（库内大写 DM04、查询小写 dm04 也命中）', async () => {
    await prisma.knowledgeItem.create({
      data: {
        kind: 'price',
        title: `${tag}门店窗膜组合口径`,
        content: `${tag}窗膜组合：DM04+DM13+DM14=4600 元`,
        source: '门店知识源',
        status: 'active',
        createdBy: 'test',
      },
    });
    await api('post', '/api/v1/agent/chat', salesToken)
      .send({ message: `dm04 组合多少钱 ${tag}` })
      .expect(201);
    const ctx = gateway.submitted[gateway.submitted.length - 1].context;
    expect(String(ctx.knowledgeContext)).toContain('4600'); // 大写 DM04 内容被小写查询命中
  });

  it('输出归一（2026-08-26 门店实测降级修复）：纯文本/markdown 围栏均救成 done 的 {reply}', async () => {
    // 纯文本形态
    gateway.output = '1+1=2，因为整数加法公理。还有什么贴膜相关的问题吗？';
    const plain = await api('post', '/api/v1/agent/chat', salesToken)
      .send({ message: '1+1为什么等于2' })
      .expect(201);
    expect(plain.body).toMatchObject({ status: 'done' });
    expect((plain.body as TaskBody).output).toMatchObject({
      reply: '1+1=2，因为整数加法公理。还有什么贴膜相关的问题吗？',
    });

    // markdown 围栏 JSON 形态
    gateway.output = '```json\n{"reply":"好的","suggestions":["复制话术"]}\n```';
    const fenced = await api('post', '/api/v1/agent/chat', salesToken)
      .send({ message: '再试一次' })
      .expect(201);
    expect((fenced.body as TaskBody).output).toMatchObject({ reply: '好的' });

    // 对象缺 reply 但有 text 键
    gateway.output = { text: '兜底文案' };
    const obj = await api('post', '/api/v1/agent/chat', salesToken)
      .send({ message: '第三次' })
      .expect(201);
    expect((obj.body as TaskBody).output).toMatchObject({ reply: '兜底文案' });

    // 键名漂移 {answer,citations,confidence}（2026-08-26 门店实测「又离线」根因）→ 救成 done 且保留截断建议
    gateway.output = {
      answer: 'DM04 是旗舰隔热膜，DM13 是经典入门款',
      citations: [{ title: '知识', kind: 'sales-script', source: 'fake', version: '2026-08' }],
      confidence: 'medium',
      suggestions: ['问1', '问2', '问3', '问4'],
    };
    const drifted = await api('post', '/api/v1/agent/chat', salesToken)
      .send({ message: 'DM04 和 DM13 区别' })
      .expect(201);
    expect((drifted.body as TaskBody).status).toBe('done');
    expect((drifted.body as TaskBody).output).toMatchObject({
      reply: 'DM04 是旗舰隔热膜，DM13 是经典入门款',
      suggestions: ['问1', '问2', '问3'],
    });

    // 建议追问超 3 条截断到 3（reply 用中文：postLint 上线后非中文回复会整单 failed）
    gateway.output = {
      reply: '好的',
      suggestions: ['问1', '问2', '问3', '问4', '问5'],
    };
    const capped = await api('post', '/api/v1/agent/chat', salesToken)
      .send({ message: '截断验证' })
      .expect(201);
    expect((capped.body as TaskBody).output).toMatchObject({
      reply: '好的',
      suggestions: ['问1', '问2', '问3'],
    });

    // 单条超 50 字截断（2026-08-26 实测根因：长建议句导致整单降级）
    const long =
      '这是一条超过五十个字符的超长建议追问句子用来验证归一层会把单条截断到五十个字符以内而不是让整单降级掉';
    gateway.output = { reply: '好的呀', suggestions: [long, '问2'] };
    const clipped = await api('post', '/api/v1/agent/chat', salesToken)
      .send({ message: '长度截断验证' })
      .expect(201);
    const clippedOut = (clipped.body as TaskBody).output as { suggestions?: string[] };
    expect(clippedOut.suggestions?.[0]?.length).toBeLessThanOrEqual(50);
    expect(clippedOut.suggestions).toHaveLength(2);

    gateway.output = { reply: '（fake）好的，话术如下…', suggestions: ['复制话术', '再来一条'] };
  });

  it('registry：skill-sales-agent 已注册且输出 schema 强校验 reply/suggestions', () => {
    const registry = app.get<AiTaskRegistry>(AiTaskRegistry);
    const def = registry.get('sales.agent.chat');
    expect(def.skillName).toBe('skill-sales-agent');
    expect(def.outputSchema.parse({ reply: 'ok' })).toBeTruthy();
    expect(() => def.outputSchema.parse({})).toThrow();
    expect(() =>
      def.outputSchema.parse({ reply: 'ok', suggestions: Array.from({ length: 6 }, () => 'y') }),
    ).toThrow();
  });

  it('决策留痕（T2）：输出含 reasoning → done 且原样落库（≤200 字可选字段）', async () => {
    gateway.output = {
      reply: '已按老客户复购场景写好催单话术。',
      reasoning: '选催单方向因为客户上月刚问过价；参考了知识库报价口径；放弃了首次触达话术。',
    };
    const res = await api('post', '/api/v1/agent/chat', salesToken)
      .send({ message: '给老客户写条催单话术' })
      .expect(201);
    const body = res.body as TaskBody;
    expect(body.status).toBe('done');
    expect((body.output as { reply?: unknown; reasoning?: string }).reasoning).toBe(
      '选催单方向因为客户上月刚问过价；参考了知识库报价口径；放弃了首次触达话术。',
    );

    // 超 200 字 reasoning → normalize 截断到 200 救成 done（suggestions 同哲学：
    // 决策说明偶发超长不拖整单降级）
    gateway.output = {
      reply: '好的',
      reasoning: '长'.repeat(260),
    };
    const over = await api('post', '/api/v1/agent/chat', salesToken)
      .send({ message: '再来一条' })
      .expect(201);
    expect((over.body as TaskBody).status).toBe('done');
    expect(((over.body as TaskBody).output as { reasoning?: string }).reasoning?.length).toBe(200);

    gateway.output = { reply: '（fake）好的，话术如下…', suggestions: ['复制话术', '再来一条'] };
  });

  it('流式（2026-08-26）：delta 按已生成 reply 前缀增量下发，done 为权威终稿', async () => {
    gateway.streamReplay = [
      '{"re',
      '{"reply":"您好',
      '{"reply":"您好，小周为您服务',
      '{"reply":"您好，小周为您服务","suggestions":["复制话术"]}',
    ];
    gateway.output = { reply: '您好，小周为您服务', suggestions: ['复制话术'] };
    const res = await api('post', '/api/v1/agent/chat/stream', salesToken)
      .send({ message: '打个招呼' })
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);
    const text = res.text;
    const deltas = [...text.matchAll(/event: delta\ndata: (.*)\n/g)].map(
      (m) => (JSON.parse(m[1]) as { text: string }).text,
    );
    // 增量拼接 = 终稿 reply（JSON 语法不外露）
    expect(deltas.join('')).toBe('您好，小周为您服务');
    expect(deltas[0]).toBe('您好');
    expect(text).toContain('event: done');
    expect(text).toContain('"reply":"您好，小周为您服务"');
    expect(text).toContain('"suggestions":["复制话术"]');
    gateway.streamReplay = [];
  });

  it('流式：网关异常 → SSE error 事件（离线口径），不悬挂连接', async () => {
    gateway.failNext = true;
    const res = await api('post', '/api/v1/agent/chat/stream', salesToken)
      .send({ message: '触发失败' })
      .expect(200);
    expect(res.text).toContain('event: error');
    expect(res.text).toContain('AI 暂时离线');
  });

  it('流式：匿名 401（SSE 头未开启前由全局守卫拦截）', async () => {
    await api('post', '/api/v1/agent/chat/stream').send({ message: 'hi' }).expect(401);
  });

  it('图片素材（2026-08-26 老板反馈放开全类型）：报价图与未授权案例图都进候选并带 licensed 标记', async () => {
    const asset = await prisma.asset.create({
      data: {
        kind: 'quote_image',
        title: `${tag}车衣双膜报价图`,
        filePath: 'assets/fake-quote.png',
        licensed: true,
        createdBy: 'test',
        mediaType: 'image',
      },
    });
    // 未授权完工案例：也应进入候选（带 licensed=false，发不发客户由人工判断）
    const unlicensed = await prisma.asset.create({
      data: {
        kind: 'finished',
        title: `${tag}领克09完工案例`,
        filePath: 'assets/fake-case.png',
        licensed: false,
        createdBy: 'test',
        mediaType: 'image',
      },
    });
    // 非图片素材（产品文档）不进候选
    const doc = await prisma.asset.create({
      data: {
        kind: 'product_doc',
        title: `${tag}产品手册`,
        filePath: 'assets/fake-doc.pdf',
        licensed: true,
        createdBy: 'test',
        mediaType: 'pdf',
      },
    });

    gateway.output = {
      reply: '已找到素材，就在下方。',
      assets: [asset.id, unlicensed.id, 'cmt_bogus_id'],
    };
    const res = await api('post', '/api/v1/agent/chat/stream', salesToken)
      .send({ message: `把${tag}车衣报价图和领克09案例图发给我` })
      .expect(200);
    const text = res.text;

    // 预检索注入：两类图片素材都进候选，非图片不进
    const ctx = gateway.submitted[gateway.submitted.length - 1].context as {
      assetCandidates: Array<{ id: string; licensed: boolean }>;
    };
    const ids = ctx.assetCandidates.map((a) => a.id);
    expect(ids).toContain(asset.id);
    expect(ids).toContain(unlicensed.id);
    expect(ids).not.toContain(doc.id);
    expect(ctx.assetCandidates.find((a) => a.id === unlicensed.id)?.licensed).toBe(false);

    // done 富化：真实 id 保留（带 licensed）、编造 id 丢弃
    expect(text).toContain('event: done');
    const doneLine = text.split('\n').find((l) => l.startsWith('data: ') && l.includes('"reply"'));
    expect(doneLine).toBeTruthy();
    const done = JSON.parse((doneLine ?? '').slice(6)) as {
      assets: Array<{ id: string; licensed: boolean }>;
    };
    expect(done.assets).toEqual([
      { id: asset.id, title: `${tag}车衣双膜报价图`, licensed: true },
      { id: unlicensed.id, title: `${tag}领克09完工案例`, licensed: false },
    ]);

    gateway.output = { reply: '（fake）好的，话术如下…', suggestions: ['复制话术', '再来一条'] };
  });

  it('图片素材：消息不涉及图时上下文无 assetCandidates 键', async () => {
    await api('post', '/api/v1/agent/chat', salesToken)
      .send({ message: '写条早安朋友圈' })
      .expect(201);
    const ctx = gateway.submitted[gateway.submitted.length - 1].context;
    expect('assetCandidates' in ctx).toBe(false);
  });
});
