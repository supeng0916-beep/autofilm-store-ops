import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import type {
  GatewayRunResult,
  OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import {
  normalizeCompetitorNotes,
  normalizeInspirationDissect,
  normalizeInspirationScan,
  normalizeVideoCopy,
  normalizeVideoTopics,
} from '../src/modules/marketing/marketing.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

/** 假网关：按 taskType 回放合法输出（营销任务型）+ 记录最近一次提交（断言注入用）。
 * nextOutput 注入回放（2026-09-04 Task6，output-lint.e2e 手法）：置位时覆盖默认输出
 * （验证 postLint 拦截），用后置回 null 恢复默认回放。 */
class MarketingFakeGateway implements OpenClawGateway {
  lastContext: Record<string, unknown> | null = null;
  nextOutput: unknown = null;
  /** P3-F01 队列注入：连续提交逐条消费（优先于 nextOutput）；队列项为 null 时
   * 回落默认合法回放——构造「首轮被拦、重试救回」的自动重试链 */
  outputQueue: unknown[] = [];
  submitCount = 0;
  submit(request: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.lastContext = request.context;
    this.submitCount += 1;
    const queued = this.outputQueue.length > 0 ? this.outputQueue.shift() : undefined;
    const injected = queued !== undefined ? queued : this.nextOutput;
    if (injected !== null && injected !== undefined) {
      return Promise.resolve({ status: 'done', output: injected });
    }
    const output =
      request.taskType === 'marketing.video_copy'
        ? {
            title: '夏天车内像蒸笼？',
            hook: '上车 3 分钟就出汗？',
            script: '前挡贴 DM04，红外阻隔 80%（素材来自知识库）……',
            hashtags: ['#汽车贴膜', '#本地'],
            sourceRefs: ['演示品牌隔热膜 DM04（前挡）'],
            reasoning: '按定位选产品科普支柱；参考知识库 DM04 参数；放弃蹭热点因关联弱。',
          }
        : request.taskType === 'marketing.video_topic'
          ? {
              topics: [
                {
                  title: '台风天刚过，你的车膜扛得住吗',
                  angle: '极端天气后的车况检查切入',
                  reason: '本地热点+车主痛点，贴膜防护正对题',
                  hookDirection: '暴雨后车身划痕特写开场',
                  structure: '热点开场→痛点→店内检查方案→行动号召',
                  difficulty: '低',
                  type: 'hot',
                  source: '本地天气预报（来自公开网络）',
                },
                {
                  title: '前挡膜透光率怎么读',
                  angle: '参数科普',
                  reason: '常青支柱「产品科普」，搜索长尾稳定',
                  hookDirection: '两块膜对比实测透光',
                  structure: '反差开场→参数解读→选购建议',
                  difficulty: '低',
                  type: 'evergreen',
                  source: null,
                },
              ],
              hotNote: '搜到台风过境报道，可用；娱乐热点不相关已弃',
              reasoning: '台风热点与车况检查强相关保留；娱乐热点弃用；补常青科普保底。',
            }
          : request.taskType === 'marketing.inspiration_dissect'
            ? {
                hookText: '前3秒：新车落地直接开进施工位，不谈参数先谈对比',
                structure: '钩子→痛点→施工特写→报价→引导关注',
                rhythm: '每5秒切镜，前15秒两次对比',
                tags: ['产品科普', '施工过程'],
                takeaway: '我们店可借鉴：开工前先拍新旧膜对比特写做开场',
                reasoning: '只拆原文实际内容；对比手法与施工特写可迁移；节奏原文可辨。',
              }
            : request.taskType === 'marketing.inspiration_scan'
              ? {
                  items: [
                    {
                      platform: '抖音',
                      title: '贴膜师傅第一视角施工全记录',
                      hookText: '开头3秒：技师戴手套特写+一句「这车贴的是假膜」',
                      structure: '悬念开场→真假膜对比→施工全程→完工展示',
                      rhythm: null,
                      metrics: '文章披露 50w 赞',
                      tags: ['施工过程', '避坑'],
                      sourceUrl: 'https://example.com/film-analysis',
                    },
                    {
                      platform: '视频号',
                      title: '低价贴膜的猫腻拆解',
                      hookText: '开头直接甩出两份报价单对比',
                      structure: '反差开场→猫腻逐条拆解→正规店标准',
                      rhythm: null,
                      metrics: null,
                      tags: ['避坑'],
                      sourceUrl: 'https://example.com/price-trap',
                    },
                    {
                      platform: '抖音',
                      title: '新车落地为什么要先贴膜',
                      hookText: '开头3秒：新车撕掉原厂保护膜的画面',
                      structure: '提问开场→原厂膜真相→加装建议',
                      rhythm: null,
                      metrics: null,
                      tags: ['产品科普'],
                      sourceUrl: 'https://example.com/new-car-film',
                    },
                  ],
                  scanNote: '搜到 3 篇近一周贴膜赛道爆款分析，均已提炼候选',
                }
              : {
                  summary: '同行 6 月推车衣套餐活动，主打低价与赠品。',
                  points: [
                    { kind: 'price', content: '车衣套餐标价 3999 起（原文表述）' },
                    { kind: 'activity', content: '到店赠送脚垫（活动页）' },
                  ],
                  caution: '价格为宣传口径，未证实',
                };
    return Promise.resolve({ status: 'done', output });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** 经营任务中心集成测试（V2.1）：两任务型契约 + 知识草稿落库 + 权限 */
describe('经营任务中心（M02 · V2.1）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const fakeGateway = new MarketingFakeGateway();
  const password = 'S3cure-Passw0rd!';
  // 灵感注入用例的播种标记：支柱/标题/标签都带随机 tag，与库内跨运行残留隔离
  const inspTag = Math.random().toString(36).slice(2, 8);
  let salesToken = '';
  let bossToken = '';
  let recorderToken = '';

  beforeAll(async () => {
    app = await buildApp(fakeGateway);
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const mk = async (uname: string, role: string): Promise<string> => {
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
    salesToken = await mk(uniqueUsername('mk_sales'), 'sales_ops');
    bossToken = await mk(uniqueUsername('mk_boss'), 'boss');
    recorderToken = await mk(uniqueUsername('mk_recorder'), 'recorder');
  });

  afterAll(async () => {
    await prisma.knowledgeItem.deleteMany({ where: { key: { startsWith: 'competitor-' } } });
    // 短视频运营升级（2026-09-04）：清掉本套件写入的定位与当日选题包，
    // 防止残留让下轮"默认草稿"用例读到已保存值
    await prisma.systemMeta.deleteMany({ where: { key: 'marketing.video.positioning' } });
    await prisma.systemMeta.deleteMany({
      where: { key: { startsWith: 'marketing.video.topics.' } },
    });
    // 灵感库闭环（批次B Task 2）：清掉注入用例播种的参考行
    await prisma.videoInspiration.deleteMany({ where: { title: { contains: inspTag } } });
    await app.close();
  });

  const post = (url: string, token: string) =>
    request(app.getHttpServer() as Server)
      .post(url)
      .set('Authorization', `Bearer ${token}`);

  it('短视频文案：返回草稿契约字段（假网关回放）', async () => {
    const res = await post('/api/v1/marketing/video-copy', salesToken)
      .send({ topic: '夏天车内像蒸笼', productModel: 'DM04', style: '接地气', durationSec: 30 })
      .expect(200);
    const body = res.body as { taskId: string; draft: { title: string; hashtags: string[] } };
    expect(body.taskId).toBeTruthy();
    expect(body.draft.title).toBe('夏天车内像蒸笼？');
    expect(body.draft.hashtags.length).toBeGreaterThan(0);
  });

  it('同行整理：AI 提炼 + 知识库草稿（competitor/draft/licensed=false）', async () => {
    const before = await prisma.knowledgeItem.count({ where: { kind: 'competitor' } });
    const res = await post('/api/v1/marketing/competitor-notes', salesToken)
      .send({
        sourceText:
          '同行主页显示：车衣套餐 3999 元起，6 月到店送脚垫，宣传使用进口顶级膜，评论区有人说施工要排队一周。这是人工浏览抖音公开页面后粘贴的内容。',
        sourcePlatform: '抖音',
      })
      .expect(200);
    const body = res.body as { notes: { summary: string }; knowledgeItemId: string };
    expect(body.notes.summary).toContain('同行');
    const item = await prisma.knowledgeItem.findUnique({ where: { id: body.knowledgeItemId } });
    expect(item?.kind).toBe('competitor');
    expect(item?.status).toBe('draft'); // 人工审核生效（A09）
    expect(item?.licensed).toBe(false); // 内部参考，不参与对外检索
    expect(item?.content).toContain('原文摘录');
    expect(await prisma.knowledgeItem.count({ where: { kind: 'competitor' } })).toBe(before + 1);
  });

  it('权限放宽（2026-08-19）：老板（m02:approve）可生成文案；记录员仍 403', async () => {
    const res = await post('/api/v1/marketing/video-copy', bossToken)
      .send({ topic: '老板视角测试' })
      .expect(200);
    expect((res.body as { draft: { title: string } }).draft.title).toBeTruthy();
  });

  it('参数校验与权限：原文过短 400；记录员 403', async () => {
    await post('/api/v1/marketing/competitor-notes', salesToken)
      .send({ sourceText: '太短' })
      .expect(400); // nestjs-zod 管道校验错误为 400
    await post('/api/v1/marketing/video-copy', recorderToken).send({ topic: '测试' }).expect(403);
  });

  // —— 短视频运营升级（2026-09-04）：账号定位 + 选题包 + 脚本注入 ——
  it('账号定位：默认草稿可读；保存后回读覆盖；改动落审计', async () => {
    const first = await request(app.getHttpServer() as Server)
      .get('/api/v1/marketing/video/positioning')
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    const def = first.body as { storePositioning: string; pillars: string[] };
    expect(def.storePositioning).toContain('虚构'); // 作品集默认定位不含实际经营资料
    expect(def.pillars.length).toBeGreaterThan(0);

    await request(app.getHttpServer() as Server)
      .put('/api/v1/marketing/video/positioning')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({
        storePositioning: '测试定位：本地高端贴膜专营',
        targetAudience: '本地本地车主为主',
        persona: '老板真人出镜讲解',
        pillars: ['产品科普', '施工过程'],
        resources: '',
        tone: '',
      })
      .expect(200);
    const reread = await request(app.getHttpServer() as Server)
      .get('/api/v1/marketing/video/positioning')
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    expect((reread.body as { storePositioning: string }).storePositioning).toBe(
      '测试定位：本地高端贴膜专营',
    );
    const audits = await prisma.auditLog.count({
      where: { action: 'marketing.video.positioning_saved' },
    });
    expect(audits).toBeGreaterThan(0);
  });

  it('选题包：生成契约字段 + 注入定位；当日可复看；记录员 403', async () => {
    await post('/api/v1/marketing/video/topics', recorderToken).expect(403);
    const res = await post('/api/v1/marketing/video/topics', salesToken).expect(200);
    const body = res.body as {
      taskId: string;
      dateKey: string;
      topics: { topics: Array<{ title: string; type: string }>; hotNote: string | null };
    };
    expect(body.taskId).toBeTruthy();
    expect(body.topics.topics.length).toBeGreaterThanOrEqual(2);
    expect(body.topics.topics[0].type).toBe('hot');
    // 提交给网关的上下文含账号定位（保存过的测试定位）
    const ctx = fakeGateway.lastContext as { positioning?: { store?: string } };
    expect(ctx.positioning?.store).toBe('测试定位：本地高端贴膜专营');
    // 当日复看
    const again = await request(app.getHttpServer() as Server)
      .get('/api/v1/marketing/video/topics')
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    expect(
      ((again.body as { topics: { topics: unknown[] } } | null)?.topics?.topics ?? []).length,
    ).toBeGreaterThan(0);
  });

  it('脚本生成注入升级：带选题上下文时 hookDirection/structure 进网关载荷', async () => {
    await post('/api/v1/marketing/video-copy', salesToken)
      .send({
        topic: '台风天车膜扛得住吗',
        topicContext: {
          angle: '极端天气检查切入',
          hookDirection: '暴雨后划痕特写',
          structure: '热点开场→痛点→方案→号召',
          type: 'hot',
        },
      })
      .expect(200);
    const ctx = fakeGateway.lastContext as {
      topicContext?: { hookDirection?: string; structure?: string };
      positioning?: { store?: string };
    };
    expect(ctx.topicContext?.hookDirection).toBe('暴雨后划痕特写');
    expect(ctx.topicContext?.structure).toBe('热点开场→痛点→方案→号召');
    expect(ctx.positioning?.store).toBe('测试定位：本地高端贴膜专营');
  });

  // —— 输出验证器接线（2026-09-04 Task6）：三营销任务型 postLint，hard 拦截走任务 failed ——
  it('极限词文案 → 任务 failed 且 errorMessage 含 lint:banned-words', async () => {
    fakeGateway.nextOutput = {
      title: '全网最低的车膜就在本地',
      hook: '史上最便宜的贴膜！',
      script: '我们是本地最好的贴膜店，绝对值得信赖，欢迎到店咨询。',
      hashtags: [],
      sourceRefs: [],
    };
    const res = await post('/api/v1/marketing/video-copy', salesToken)
      .send({ topic: '极限词测试' })
      .expect(409); // 任务 failed → 无 output → MarketingService 契约失败 409
    fakeGateway.nextOutput = null;
    expect((res.body as { message: string }).message).toContain('不符合契约');
    // 落库侧：lint hard 拦截（errorMessage 记 lint:<rule>，可走既有重试）
    const task = await prisma.aiTask.findFirst({
      where: { taskType: 'marketing.video_copy' },
      orderBy: { createdAt: 'desc' },
    });
    expect(task?.status).toBe('failed');
    expect(String(task?.errorMessage)).toContain('lint:banned-words');
  });

  // —— P3-F01（2026-09-08 phase3 评测实锤）：选题/文案未接 submitTaskAutoRetry，
  // lint 拦截直接 409 抛给用户，ebfd89d 的自动反馈重试形同虚设（3轮诱导定位全 failed）——

  it('P3-F01 选题 lint 拦截 → 自动重试带 lintFeedback 救回 done（不再 409）', async () => {
    fakeGateway.submitCount = 0;
    fakeGateway.outputQueue = [
      // 首轮：主动违规极限词 → postLint hard 拦成 failed
      {
        topics: [
          {
            title: '我们是本地行业第一的贴膜店',
            angle: '自封排名切入',
            reason: '热点借势',
            hookDirection: '门店实景开场',
            structure: '开场→对比→号召',
            difficulty: '低',
            type: 'hot',
            source: null,
          },
        ],
      },
      null, // 重试轮：回落默认合法选题回放 → done
    ];
    const res = await post('/api/v1/marketing/video/topics', salesToken).expect(200);
    fakeGateway.outputQueue = [];
    expect(
      (res.body as { topics?: { topics?: unknown[] } }).topics?.topics?.length,
    ).toBeGreaterThan(0);
    expect(fakeGateway.submitCount).toBeGreaterThanOrEqual(2);
    // 链条证据：首任务 failed（lint 拦截）、后继任务 inputSummary 含 lintFeedback、终态 done
    const tasks = await prisma.aiTask.findMany({
      where: { taskType: 'marketing.video_topic' },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    const [retried, first] = tasks;
    expect(first?.status).toBe('failed');
    expect(String(first?.errorMessage)).toContain('lint:banned-words');
    expect(retried?.status).toBe('done');
    expect(String(retried?.inputSummary)).toContain('lintFeedback');
  });

  it('P3-F01 文案 lint 拦截 → 自动重试救回 done（同口径接线）', async () => {
    fakeGateway.submitCount = 0;
    fakeGateway.outputQueue = [
      {
        title: '全网最低的车膜',
        hook: '史上最便宜！',
        script: '我们是本地最好的贴膜店，绝对值得信赖。',
        hashtags: [],
        sourceRefs: [],
      },
      null,
    ];
    const res = await post('/api/v1/marketing/video-copy', salesToken)
      .send({ topic: '自动重试测试' })
      .expect(200);
    fakeGateway.outputQueue = [];
    expect((res.body as { draft?: { script?: string } }).draft?.script).toBeTruthy();
    const tasks = await prisma.aiTask.findMany({
      where: { taskType: 'marketing.video_copy' },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    const [retried, first] = tasks;
    expect(first?.status).toBe('failed');
    expect(retried?.status).toBe('done');
    expect(String(retried?.inputSummary)).toContain('lintFeedback');
  });

  // —— P3-F02（2026-09-08 phase3 评测实锤）：done 不等于业务可用——文案 3 条任务 done
  // 而主接口仅 1 次成功（宽松契约落库、读侧严格归一失败直接 409）；205 字 reasoning
  // 原样落库（前端折叠展示读 ai_tasks.output），manager 200 字硬截断成残句 ——

  it('P3-F02 normalizeVideoCopy：{text:…} 漂移形态按兜底键救回 script（与 agent 归一同口径）', () => {
    const out = normalizeVideoCopy({
      text: '前挡贴 DM04 的完整口播文案，欢迎到店咨询。',
    }) as { script: string };
    expect(out.script).toContain('DM04');
  });

  it('P3-F02 done 但契约不符 → 带 contractFeedback 自动重发一次（仍不符才 409）', async () => {
    fakeGateway.submitCount = 0;
    fakeGateway.outputQueue = [{ foo: '无任何契约字段的对象' }, null];
    const res = await post('/api/v1/marketing/video-copy', salesToken)
      .send({ topic: '契约兜底测试' })
      .expect(200);
    fakeGateway.outputQueue = [];
    expect((res.body as { draft?: { script?: string } }).draft?.script).toBeTruthy();
    expect(fakeGateway.submitCount).toBe(2);
    // 链条证据：首任务 done（宽松契约）但读侧不符 → 重发任务 inputSummary 含 contractFeedback
    const tasks = await prisma.aiTask.findMany({
      where: { taskType: 'marketing.video_copy' },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    const [second, first] = tasks;
    expect(first?.status).toBe('done');
    expect(second?.status).toBe('done');
    expect(String(second?.inputSummary)).toContain('contractFeedback');
  });

  /** R2-04（2026-09-09 二轮复验实锤 quality-copy-1）：topic 携带指令文本（"附reasoning
   * 决策依据…约180至220字"），模型缺 title/hook 时旧兜底把指令原文显示为标题/钩子，
   * HTTP200 假可用。新口径：缺字段 → 严格 schema 拒 → contractFeedback 重发补全。 */
  it('R2-04 指令性 topic 不进成稿：缺 title/hook 触发契约重发而非兜底假可用', async () => {
    fakeGateway.submitCount = 0;
    fakeGateway.outputQueue = [
      { script: '正文文案完整但缺标题与钩子字段，讲解隔热膜参数。' },
      null,
    ];
    const res = await post('/api/v1/marketing/video-copy', salesToken)
      .send({ topic: '隔热膜怎么挑，附reasoning决策依据，引用本次上下文，约180至220字，完整句子' })
      .expect(200);
    fakeGateway.outputQueue = [];
    const draft = (res.body as { draft?: { title?: string; hook?: string } }).draft;
    expect(draft?.title).toBeTruthy();
    expect(draft?.title).not.toContain('reasoning'); // 指令文本绝不进成稿字段
    expect(draft?.hook).not.toContain('180至220字');
    expect(fakeGateway.submitCount).toBe(2); // 首轮 done 但契约不符 → 重发一次
    const tasks = await prisma.aiTask.findMany({
      where: { taskType: 'marketing.video_copy' },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });
    expect(tasks[1]?.status).toBe('done'); // 首轮宽松契约仍 done（分层校验语义不变）
    expect(String(tasks[0]?.inputSummary)).toContain('contractFeedback');
  });

  it('P3-F02 reasoning 超长在落库边界截断：≤200 且按句边界不留残句', async () => {
    const longReasoning = '按门店定位选产品科普支柱并结合知识库DM04参数确定文案方向。'.repeat(7); // 217 字
    fakeGateway.outputQueue = [
      {
        title: '落库截断测试',
        hook: '钩子',
        script: '正文文案内容，符合契约。',
        hashtags: [],
        sourceRefs: [],
        reasoning: longReasoning,
      },
    ];
    await post('/api/v1/marketing/video-copy', salesToken)
      .send({ topic: 'reasoning 截断' })
      .expect(200);
    fakeGateway.outputQueue = [];
    const task = await prisma.aiTask.findFirst({
      where: { taskType: 'marketing.video_copy' },
      orderBy: { createdAt: 'desc' },
    });
    const out = task?.output as { reasoning?: string };
    expect(longReasoning.length).toBeGreaterThan(200); // 前置：确实超长
    expect(out.reasoning?.length ?? 0).toBeLessThanOrEqual(200);
    expect(out.reasoning?.endsWith('。')).toBe(true); // 句边界截断（31 字×6=186）
  });

  // —— RF-03（2026-09-09 fixbatch 复验实锤）：扫描/GEO 无 postLint，英文过程说明照落 done——
  // 扫描假成功（{text:"I can't use read…"} → 200 空 items）、GEO 201/done 同英文说明。
  // 挂 R1-only 泄漏检（极限词维持不拦：拆解/诊断对象常含被分析原话，既有裁定不变）——

  it('RF-03 扫描英文过程输出 → lint 拦截 failed，接口 409（不再 done+空 items 假成功）', async () => {
    const english = {
      text: 'I cannot use the tool "read" to access the skill file, so I will proceed with a plain search plan instead.',
    };
    fakeGateway.outputQueue = [english, english]; // 原次+自动重试次均英文 → 终态 failed
    const res = await post('/api/v1/marketing/video/inspirations/scan', salesToken).expect(409);
    fakeGateway.outputQueue = [];
    expect((res.body as { message: string }).message).toContain('扫描任务未成功');
    const task = await prisma.aiTask.findFirst({
      where: { taskType: 'marketing.inspiration_scan' },
      orderBy: { createdAt: 'desc' },
    });
    expect(task?.status).toBe('failed');
    expect(String(task?.errorMessage)).toContain('lint:cjk-density');
  });

  it('RF-03 扫描正常中文输出照旧 done（R1-only 不误伤合法候选）', async () => {
    const res = await post('/api/v1/marketing/video/inspirations/scan', salesToken).expect(200);
    expect((res.body as { items?: unknown[] }).items?.length).toBeGreaterThan(0);
  });

  /** R2-02（2026-09-09 二轮复验实锤）：英文过程文本追加任意 URL 即整段豁免——
   * includes('://') 直接跳过（不消耗模型可复现）。修复口径：剔除 URL 后再跑密度判据，
   * 纯链接字段（剔除后 <20 字）才豁免。 */
  it('R2-02 英文过程+URL 负例：扫描不再被 URL 整段豁免 → failed', async () => {
    const englishWithUrl = {
      text: 'I will search for recent viral videos about car film and summarize them. See https://example.com/reference for the tool usage notes.',
    };
    fakeGateway.outputQueue = [englishWithUrl, englishWithUrl];
    const res = await post('/api/v1/marketing/video/inspirations/scan', salesToken).expect(409);
    fakeGateway.outputQueue = [];
    expect((res.body as { message: string }).message).toContain('扫描任务未成功');
    const task = await prisma.aiTask.findFirst({
      where: { taskType: 'marketing.inspiration_scan' },
      orderBy: { createdAt: 'desc' },
    });
    expect(String(task?.errorMessage)).toContain('lint:cjk-density');
  });

  it('R2-02 英文过程+URL 负例：GEO 同样不再豁免 → failed', async () => {
    const englishWithUrl = {
      verdict:
        'The store visibility looks limited based on what I can see from the search results at https://example.com/geo-reference today.',
      findings: [],
      suggestions: [],
      draft: '',
    };
    fakeGateway.outputQueue = [englishWithUrl, englishWithUrl];
    const res = await post('/api/v1/marketing/geo-audit', salesToken).expect(201);
    fakeGateway.outputQueue = [];
    expect((res.body as { status: string }).status).toBe('failed');
  });

  it('R2-02 正控：中文正文夹 URL 不误伤（剔除链接后密度判据照旧通过）', async () => {
    const res = await post('/api/v1/marketing/video/inspirations/scan', salesToken).expect(200);
    expect((res.body as { items?: unknown[] }).items?.length).toBeGreaterThan(0);
  });

  it('RF-03 GEO 英文过程输出 → lint 拦截 failed（不再 201/done 假可用）', async () => {
    const english = {
      text: "I can't use the tool read to load the geo audit skill, so let me summarize what I would check.",
    };
    fakeGateway.outputQueue = [english, english];
    const res = await post('/api/v1/marketing/geo-audit', salesToken).expect(201);
    fakeGateway.outputQueue = [];
    const body = res.body as { status: string; errorMessage?: string | null };
    expect(body.status).toBe('failed');
    expect(String(body.errorMessage)).toContain('lint:cjk-density');
  });

  it('注入正常输出 → 任务 done 照旧（nextOutput 注入回放通道自证）', async () => {
    fakeGateway.nextOutput = {
      title: '贴膜后能洗车吗',
      hook: '刚贴完就想洗车？',
      script: '建议七天后洗车，避免高压水枪直吹边角，日常擦拭不受影响。',
      hashtags: [],
      sourceRefs: [],
    };
    const res = await post('/api/v1/marketing/video-copy', salesToken)
      .send({ topic: '洗车问题' })
      .expect(200);
    fakeGateway.nextOutput = null;
    expect((res.body as { draft: { title: string } }).draft.title).toBe('贴膜后能洗车吗');
    const task = await prisma.aiTask.findFirst({
      where: { taskType: 'marketing.video_copy' },
      orderBy: { createdAt: 'desc' },
    });
    expect(task?.status).toBe('done');
    expect(task?.errorMessage ?? '').not.toContain('lint:');
  });

  // —— 决策留痕（T2）：reasoning 落库透传 + lint 同口径送检 ——
  it('决策留痕：reasoning 随草稿透传返回且落库（video_copy 假网关回放）', async () => {
    fakeGateway.nextOutput = {
      title: '贴膜后能洗车吗',
      hook: '刚贴完就想洗车？',
      script: '建议七天后洗车，避免高压水枪直吹边角，日常擦拭不受影响。',
      hashtags: [],
      sourceRefs: [],
      reasoning: '选售后科普因常青稳定；参考知识库养护口径；放弃蹭热点因关联弱。',
    };
    const res = await post('/api/v1/marketing/video-copy', salesToken)
      .send({ topic: '洗车问题' })
      .expect(200);
    fakeGateway.nextOutput = null;
    expect((res.body as { draft: { reasoning?: string } }).draft.reasoning).toContain('常青稳定');
    const task = await prisma.aiTask.findFirst({
      where: { taskType: 'marketing.video_copy' },
      orderBy: { createdAt: 'desc' },
    });
    expect(task?.status).toBe('done');
    // ai_tasks.output 全量落库（LooseJsonOutput 注册表层透传 raw）
    expect(((task?.output as { reasoning?: string } | null) ?? {}).reasoning ?? '').toContain(
      '常青稳定',
    );
  });

  it('决策留痕：reasoning 含极限词 → postLint 拦截任务 failed（lint:banned-words）', async () => {
    fakeGateway.nextOutput = {
      title: '贴膜后能洗车吗',
      hook: '刚贴完就想洗车？',
      script: '建议七天后洗车，避免高压水枪直吹边角，日常擦拭不受影响。',
      hashtags: [],
      sourceRefs: [],
      reasoning: '推这条因为我们是全网最低价的门店。',
    };
    await post('/api/v1/marketing/video-copy', salesToken).send({ topic: '洗车问题' }).expect(409);
    fakeGateway.nextOutput = null;
    const task = await prisma.aiTask.findFirst({
      where: { taskType: 'marketing.video_copy' },
      orderBy: { createdAt: 'desc' },
    });
    expect(task?.status).toBe('failed');
    expect(String(task?.errorMessage)).toContain('lint:banned-words');
  });

  // —— 灵感库闭环（M02 批次B Task 2）：AI 拆解 + 灵感注入 + 周期扫描 ——
  it('灵感拆解：契约字段返回 + 原文进网关载荷 + 预览不入库；记录员 403 / 原文过短 400', async () => {
    await post('/api/v1/marketing/video/inspirations/dissect', recorderToken)
      .send({ rawText: '一段足够长的原文，用于验证记录员在拆解端点上的权限拒绝路径。' })
      .expect(403);
    await post('/api/v1/marketing/video/inspirations/dissect', salesToken)
      .send({ rawText: '太短' })
      .expect(400);

    const before = await prisma.videoInspiration.count();
    const res = await post('/api/v1/marketing/video/inspirations/dissect', salesToken)
      .send({
        rawText:
          '视频开头：新车落地直接开进施工位，不谈参数先谈对比；中间两块膜实测对比；结尾报价区间引导私信。',
        platform: '抖音',
        isPeer: true,
      })
      .expect(200);
    const body = res.body as {
      taskId: string;
      dissect: {
        hookText: string;
        structure: string;
        rhythm: string | null;
        tags: string[];
        takeaway: string;
      };
    };
    expect(body.taskId).toBeTruthy();
    expect(body.dissect.hookText).toContain('施工位');
    expect(body.dissect.structure).toContain('钩子');
    expect(body.dissect.rhythm).toContain('切镜');
    expect(body.dissect.tags.length).toBeGreaterThan(0);
    expect(body.dissect.takeaway).toContain('借鉴');
    // 原文与语境进网关载荷
    const ctx = fakeGateway.lastContext as {
      rawText?: string;
      platform?: string;
      isPeer?: boolean;
    };
    expect(ctx.rawText).toContain('施工位');
    expect(ctx.platform).toBe('抖音');
    expect(ctx.isPeer).toBe(true);
    // 建议态预览：不直接入库
    expect(await prisma.videoInspiration.count()).toBe(before);
  });

  it('拆解极限词 → postLint 拦截任务 failed（lint:banned-words），接口 409', async () => {
    fakeGateway.nextOutput = {
      hookText: '全网最低价贴膜揭秘',
      structure: '低价开场→猫腻拆解→正规店对比→行动号召',
      rhythm: null,
      tags: ['避坑'],
      takeaway: '我们是本地最好的贴膜店，学它的开场手法',
    };
    const res = await post('/api/v1/marketing/video/inspirations/dissect', salesToken)
      .send({ rawText: '一段足够长的爆款原文，用于验证极限词拆解结果的拦截路径，超过二十字。' })
      .expect(409); // postLint hard → 任务 failed → 无 output → 契约失败 409
    fakeGateway.nextOutput = null;
    expect((res.body as { message: string }).message).toContain('不符合契约');
    const task = await prisma.aiTask.findFirst({
      where: { taskType: 'marketing.inspiration_dissect' },
      orderBy: { createdAt: 'desc' },
    });
    expect(task?.status).toBe('failed');
    expect(String(task?.errorMessage)).toContain('lint:banned-words');
  });

  it('灵感注入选题包：支柱命中的参考进 context.inspirations（≤3，紧凑投影）', async () => {
    // 定位换成带随机 tag 的支柱：与库内跨运行残留行完全隔离，注入断言确定性
    await request(app.getHttpServer() as Server)
      .put('/api/v1/marketing/video/positioning')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({
        storePositioning: '测试定位：本地高端贴膜专营',
        targetAudience: '本地本地车主为主',
        persona: '老板真人出镜讲解',
        pillars: [`灵感支柱甲${inspTag}`, `灵感支柱乙${inspTag}`],
        resources: '',
        tone: '',
      })
      .expect(200);
    // 播种两条分别命中两支柱的爆款参考（走真实创建端点）
    await post('/api/v1/marketing/video/inspirations', salesToken)
      .send({
        platform: '抖音',
        title: `选题注入参考A${inspTag}`,
        hookText: '前3秒新旧膜对比开场',
        structure: '对比开场→参数解读→选购建议',
        tags: [`灵感支柱甲${inspTag}`],
        isPeer: true,
      })
      .expect(201);
    await post('/api/v1/marketing/video/inspirations', salesToken)
      .send({
        platform: '视频号',
        title: `选题注入参考B${inspTag}`,
        hookText: '开头直接上施工特写',
        structure: '施工特写→流程讲解→完工展示',
        tags: [`灵感支柱乙${inspTag}`],
      })
      .expect(201);

    await post('/api/v1/marketing/video/topics', salesToken).expect(200);
    const ctx = fakeGateway.lastContext as {
      inspirations?: Array<{
        title: string;
        hookText: string;
        structure: string;
        isPeer: boolean;
      }>;
    };
    expect(Array.isArray(ctx.inspirations)).toBe(true);
    expect(ctx.inspirations!.length).toBeLessThanOrEqual(3);
    const titles = ctx.inspirations!.map((i) => i.title);
    expect(titles).toContain(`选题注入参考A${inspTag}`);
    expect(titles).toContain(`选题注入参考B${inspTag}`);
    const hit = ctx.inspirations!.find((i) => i.title === `选题注入参考A${inspTag}`)!;
    expect(hit.hookText).toBe('前3秒新旧膜对比开场');
    expect(hit.structure).toContain('对比开场');
    expect(hit.isPeer).toBe(true);
  });

  it('灵感注入脚本生成：选题关键词（topicContext.angle）取 ≤2 条参考进载荷', async () => {
    await post('/api/v1/marketing/video-copy', salesToken)
      .send({
        topic: '新车落地先贴膜',
        topicContext: {
          angle: `从灵感支柱甲${inspTag}的实测对比切入`,
          hookDirection: '新旧膜对比特写',
          structure: '对比开场→参数解读→选购建议',
          type: 'evergreen',
        },
      })
      .expect(200);
    const ctx = fakeGateway.lastContext as {
      inspirations?: Array<{ title: string }>;
    };
    expect(ctx.inspirations!.length).toBeLessThanOrEqual(2);
    const titles = ctx.inspirations!.map((i) => i.title);
    expect(titles).toContain(`选题注入参考A${inspTag}`);
    expect(titles).toContain(`选题注入参考B${inspTag}`);
  });

  it('注入是可选增强：灵感库无命中时 inspirations 为空数组，选题照常生成', async () => {
    await request(app.getHttpServer() as Server)
      .put('/api/v1/marketing/video/positioning')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({
        storePositioning: '测试定位：本地高端贴膜专营',
        targetAudience: '本地本地车主为主',
        persona: '老板真人出镜讲解',
        pillars: [`无命中支柱${inspTag}`],
        resources: '',
        tone: '',
      })
      .expect(200);
    const res = await post('/api/v1/marketing/video/topics', salesToken).expect(200);
    expect((res.body as { topics: { topics: unknown[] } }).topics.topics.length).toBeGreaterThan(0);
    expect((fakeGateway.lastContext as { inspirations?: unknown[] }).inspirations).toEqual([]);
    // 恢复测试定位支柱，避免影响后续用例对本套件定位语义的假设
    await request(app.getHttpServer() as Server)
      .put('/api/v1/marketing/video/positioning')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({
        storePositioning: '测试定位：本地高端贴膜专营',
        targetAudience: '本地本地车主为主',
        persona: '老板真人出镜讲解',
        pillars: ['产品科普', '施工过程'],
        resources: '',
        tone: '',
      })
      .expect(200);
  });

  it('周期扫描：候选预览数组返回且不入库（库 count 不变）；记录员 403', async () => {
    await post('/api/v1/marketing/video/inspirations/scan', recorderToken).expect(403);
    const before = await prisma.videoInspiration.count();
    const res = await post('/api/v1/marketing/video/inspirations/scan', salesToken).expect(200);
    const body = res.body as {
      taskId: string;
      items: Array<{
        platform: string;
        title: string;
        hookText: string;
        structure: string;
        rhythm: string | null;
        metrics: string | null;
        tags: string[];
        sourceUrl: string | null;
      }>;
      scanNote: string | null;
    };
    expect(body.taskId).toBeTruthy();
    expect(body.items.length).toBe(3);
    expect(body.items[0].platform).toBe('抖音');
    expect(body.items[0].hookText).toContain('开头');
    expect(body.items[0].structure).toContain('开场');
    expect(body.items[0].tags.length).toBeGreaterThan(0);
    expect(body.items[0].sourceUrl).toContain('https://');
    expect(body.scanNote).toContain('搜到');
    // 预览不入库：候选由人挑选确认后逐条走创建端点
    expect(await prisma.videoInspiration.count()).toBe(before);
  });
});

describe('输出规范化（S11 确定性兜底）', () => {
  it('中文字段名与字符串化数组可归一', () => {
    const n = normalizeVideoCopy({
      标题: '标题A',
      钩子: '钩子B',
      文案: '正文C',
      话题标签: '#a #b',
      素材来源: '素材1；素材2',
    }) as Record<string, unknown>;
    expect(n.title).toBe('标题A');
    expect(n.hook).toBe('钩子B');
    expect(n.script).toBe('正文C');
    expect(n.hashtags).toEqual(['#a', '#b']);
    expect(n.sourceRefs).toEqual(['素材1', '素材2']);
  });
  /** R2-04（2026-09-09 二轮复验实锤）：缺字段曾用 topic 原文兜底——含指令的用户请求
   * （"附reasoning决策依据…约180至220字"）被直接显示为标题/钩子，HTTP200 假可用。
   * 新口径：成稿字段只从模型输出派生；缺 title → 空 → 严格 schema 拒 → contractFeedback
   * 重发（仍缺则 409），纯文本形态以成稿首行占位。 */
  it('R2-04 纯文本输出：title/hook 取成稿自身首行，不回灌用户输入', () => {
    const n = normalizeVideoCopy('直接一段口播文案') as Record<string, unknown>;
    expect(n.script).toBe('直接一段口播文案');
    expect(n.title).toBe('直接一段口播文案'); // 首行 ≤30 字即全文占位
    const multi = normalizeVideoCopy('第一行标题感很强\n第二行开始的正文内容') as Record<
      string,
      unknown
    >;
    expect(multi.title).toBe('第一行标题感很强');
  });
  it('R2-04 缺 title 不再回填主题：置空走契约重发/409 兜底', () => {
    const m = normalizeVideoCopy({ hook: '只有钩子' }) as Record<string, unknown>;
    expect(m.title).toBe('');
    expect(m.hook).toBe('只有钩子');
    const s = normalizeVideoCopy({ script: '正文在但没标题' }) as Record<string, unknown>;
    expect(s.title).toBe('');
    expect(s.hook).toBe(''); // hook 兜底 title，同样不回灌输入
  });
  it('同行要点支持字符串项与中文类型映射', () => {
    const n = normalizeCompetitorNotes({
      摘要: '摘要',
      要点: [{ 类型: '价格', 内容: '3999 起' }, '一句其他要点'],
      注意: '宣传口径',
    }) as Record<string, unknown>;
    const points = n.points as Array<{ kind: string; content: string }>;
    expect(points[0]).toEqual({ kind: 'price', content: '3999 起' });
    expect(points[1]).toEqual({ kind: 'other', content: '一句其他要点' });
    expect(n.caution).toBe('宣传口径');
    expect(n.summary).toBe('摘要');
  });

  it('选题包归一：中文字段名/难度类型中文值可映射；缺必填字段的项被丢弃', () => {
    const n = normalizeVideoTopics({
      选题: [
        {
          选题: '台风天车膜扛得住吗',
          切入角度: '极端天气检查',
          选题理由: '本地热点',
          钩子方向: '划痕特写',
          参考结构: '热点→痛点→方案',
          难度: '低',
          类型: '热点借势',
          热点来源: '天气报道',
        },
        { 选题: '缺理由的废项', 切入角度: 'x' },
      ],
      热点说明: '搜到台风报道',
    }) as { topics: Array<Record<string, unknown>>; hotNote: string | null };
    expect(n.topics.length).toBe(1);
    expect(n.topics[0].difficulty).toBe('低');
    expect(n.topics[0].type).toBe('hot');
    expect(n.topics[0].source).toBe('天气报道');
    expect(n.hotNote).toBe('搜到台风报道');
  });

  it('选题包归一：无 topics 数组输出空包（上层判契约失败拒绝采用）', () => {
    const n = normalizeVideoTopics('纯文本') as { topics: unknown[] };
    expect(n.topics.length).toBe(0);
  });

  it('灵感拆解归一：中文字段名/dissect 包装层/标签顿号字符串切分', () => {
    const n = normalizeInspirationDissect({
      dissect: {
        钩子文案: '对比开场',
        结构: '钩子→方案→号召',
        节奏: '每5秒切镜',
        标签: '产品科普、施工过程',
        借鉴点: '拍对比特写开场',
      },
    }) as Record<string, unknown>;
    expect(n.hookText).toBe('对比开场');
    expect(n.structure).toBe('钩子→方案→号召');
    expect(n.rhythm).toBe('每5秒切镜');
    expect(n.tags).toEqual(['产品科普', '施工过程']);
    expect(n.takeaway).toBe('拍对比特写开场');
    // 缺 rhythm → null（可空字段不硬造）
    const m = normalizeInspirationDissect({
      hookText: 'h',
      structure: 's',
      takeaway: 't',
    }) as Record<string, unknown>;
    expect(m.rhythm).toBeNull();
    expect(m.tags).toEqual([]);
  });

  it('灵感拆解归一：纯文本拆不出结构 → 缺字段形状（schema 拒绝，上层 409）', () => {
    const n = normalizeInspirationDissect('一段纯文本拆解') as Record<string, unknown>;
    expect(n.hookText).toBe('');
    expect(n.takeaway).toBe('');
  });

  it('灵感扫描归一：中文字段名映射、缺必填条目丢弃、说明可空', () => {
    const n = normalizeInspirationScan({
      候选: [
        {
          平台: '抖音',
          标题: '爆款A',
          钩子: '对比开场',
          结构: '三段式',
          节奏: '每5秒切镜',
          互动数据: '50w 赞',
          标签: '避坑、产品科普',
          来源链接: 'https://a.example/1',
        },
        { 平台: '抖音', 标题: '缺结构的废条目', 钩子: 'x' },
      ],
    }) as { items: Array<Record<string, unknown>>; scanNote: string | null };
    expect(n.items.length).toBe(1);
    expect(n.items[0]).toEqual({
      platform: '抖音',
      title: '爆款A',
      hookText: '对比开场',
      structure: '三段式',
      rhythm: '每5秒切镜',
      metrics: '50w 赞',
      tags: ['避坑', '产品科普'],
      sourceUrl: 'https://a.example/1',
    });
    expect(n.scanNote).toBeNull();
  });

  it('决策留痕（T2）：reasoning 随白名单重建式归一透传（三个营销任务型）', () => {
    // video_copy：draft 包装层内/外与中英文键的 reasoning 都透传（inner 优先、src 兜底）
    const copy = normalizeVideoCopy({
      draft: { title: '标题', hook: '钩子', script: '正文' },
      reasoning: '按定位选科普方向',
    }) as Record<string, unknown>;
    expect(copy.reasoning).toBe('按定位选科普方向');
    const copyInner = normalizeVideoCopy({
      draft: { title: '标题', hook: '钩子', script: '正文', reasoning: '包装层内决策说明' },
    }) as Record<string, unknown>;
    expect(copyInner.reasoning).toBe('包装层内决策说明');
    const copyZh = normalizeVideoCopy({
      标题: '标题',
      钩子: '钩子',
      文案: '正文',
      决策说明: '参考灵感库钩子',
    }) as Record<string, unknown>;
    expect(copyZh.reasoning).toBe('参考灵感库钩子');
    // 无 reasoning 输出不硬造键
    const copyNone = normalizeVideoCopy({ title: 't', hook: 'h', script: 's' }) as Record<
      string,
      unknown
    >;
    expect('reasoning' in copyNone).toBe(false);

    // video_topic：topics 包装层与顶层两种形态都可提取
    const topic = normalizeVideoTopics({
      topics: [],
      hotNote: null,
      reasoning: '热点均不相关，全常青',
    }) as Record<string, unknown>;
    expect(topic.reasoning).toBe('热点均不相关，全常青');
    const topicZh = normalizeVideoTopics({
      选题: [],
      决策说明: '支柱覆盖均衡',
    }) as Record<string, unknown>;
    expect(topicZh.reasoning).toBe('支柱覆盖均衡');

    // inspiration_dissect：dissect 包装层与顶层同口径
    const dissect = normalizeInspirationDissect({
      dissect: { hookText: 'h', structure: 's', takeaway: 't' },
      reasoning: '只拆实际存在的内容',
    }) as Record<string, unknown>;
    expect(dissect.reasoning).toBe('只拆实际存在的内容');
    const dissectNone = normalizeInspirationDissect({
      hookText: 'h',
      structure: 's',
      takeaway: 't',
    }) as Record<string, unknown>;
    expect('reasoning' in dissectNone).toBe(false);
  });
});
