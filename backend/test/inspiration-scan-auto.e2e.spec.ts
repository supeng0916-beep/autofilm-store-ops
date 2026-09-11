import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import type {
  GatewayRunResult,
  OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import { InspirationScanScheduler } from '../src/modules/marketing/inspiration-scan-scheduler.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

/** 假网关：记录提交并回放可配置的 inspiration_scan 输出（默认 2 条带 tag 标题） */
class FakeScanGateway implements OpenClawGateway {
  submitted: SubmitTaskRequest[] = [];
  /** 回放的候选条目（标题由套件注入随机 tag，跨运行隔离） */
  items: Array<Record<string, unknown>> = [];
  /** 置位时回 failed（无合法输出）→ scanInspirations 抛 409 → autoScanOnce 记
   * error 不写幂等键（下小时重试语义） */
  broken = false;

  submit(req: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.submitted.push(req);
    if (this.broken) {
      return Promise.resolve({ status: 'failed', errorMessage: 'fake: 扫描失败' });
    }
    const output = { items: this.items, scanNote: '搜到近一周贴膜赛道爆款分析' };
    return Promise.resolve({ status: 'done', output, model: 'fake' });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** 灵感库每日自动扫描（T4，批次B挂账项转正）：autoScanOnce 落 candidate、
 * 当日幂等、title 查重护栏、候选堆积护栏、采纳/忽略动作与权限。
 * 定时器逻辑不测真实 cron（照 competitor-daily.spec 口径，直接调 autoScanOnce）。 */
describe('灵感库每日自动扫描（T4）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let gateway: FakeScanGateway;
  let scheduler: InspirationScanScheduler;
  const password = 'S3cure-Passw0rd!';
  // 每次运行唯一 tag：标题含 tag 隔离与清扫（测试库数据跨运行残留）
  const tag = Math.random().toString(36).slice(2, 8);
  let salesToken = '';
  let bossToken = '';
  let recorderToken = '';
  let salesId = '';
  const doneKey = 'inspiration.scan.done.' + new Date().toISOString().slice(0, 10);

  const mkUser = async (role: string): Promise<{ token: string; id: string }> => {
    const username = uniqueUsername(`t4_${role}`);
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
    const user = await prisma.user.create({
      data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username, password });
    return { token: (res.body as { accessToken: string }).accessToken, id: user.id };
  };

  beforeAll(async () => {
    gateway = new FakeScanGateway();
    app = await buildApp(gateway);
    // 停掉全部定时器（competitor-daily.spec 先例）：NODE_ENV=test 只挡了启动补跑，
    // cron 仍注册——不摘会与共享测试库的断言竞态
    const registry = app.get(SchedulerRegistry);
    for (const job of registry.getCronJobs().values()) void job.stop();
    for (const name of registry.getIntervals()) {
      clearInterval(registry.getInterval(name) as NodeJS.Timeout);
    }
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    scheduler = app.get(InspirationScanScheduler);
    for (const code of ['boss', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const sales = await mkUser('sales_ops');
    salesToken = sales.token;
    salesId = sales.id;
    bossToken = (await mkUser('boss')).token;
    recorderToken = (await mkUser('recorder')).token;
    // 默认回放 2 条候选（标题带 tag，与库内跨运行残留隔离）
    gateway.items = [
      {
        platform: '抖音',
        title: `贴膜师傅第一视角施工记录${tag}`,
        hookText: '开头3秒：技师戴手套特写+一句「这车贴的是假膜」',
        structure: '悬念开场→真假膜对比→施工全程→完工展示',
        rhythm: null,
        metrics: '文章披露 50w 赞',
        tags: ['施工过程'],
        sourceUrl: 'https://example.com/film-analysis',
      },
      {
        platform: '视频号',
        title: `低价贴膜的猫腻拆解${tag}`,
        hookText: '开头直接甩出两份报价单对比',
        structure: '反差开场→猫腻逐条拆解→正规店标准',
        rhythm: null,
        metrics: null,
        tags: ['避坑'],
        sourceUrl: 'https://example.com/price-trap',
      },
    ];
  });

  afterAll(async () => {
    // 清扫口径：按标题含 tag 清扫 + 自动扫描来源行（防上次运行中断残留撞堆积护栏）+ 当日幂等键
    await prisma.videoInspiration.deleteMany({ where: { title: { contains: tag } } });
    await prisma.videoInspiration.deleteMany({ where: { createdBy: 'inspiration-scan' } });
    await prisma.systemMeta.deleteMany({ where: { key: doneKey } });
    await app.close();
  });

  beforeEach(async () => {
    gateway.submitted = [];
    gateway.broken = false;
    // 每用例独立验证幂等语义：清当日标记与本套件残留行（含自动扫描来源的跨运行残留）
    await prisma.systemMeta.deleteMany({ where: { key: doneKey } });
    await prisma.videoInspiration.deleteMany({ where: { title: { contains: tag } } });
    await prisma.videoInspiration.deleteMany({ where: { createdBy: 'inspiration-scan' } });
  });

  it('autoScanOnce：AI 返回 2 条 → 落 2 条 candidate；当日再跑幂等跳过零新增', async () => {
    const res = await scheduler.autoScanOnce();
    expect(res.generated).toBe(true);
    expect(res.created).toBe(2);
    expect(gateway.submitted.length).toBe(1);
    expect(gateway.submitted[0]?.taskType).toBe('marketing.inspiration_scan');

    const rows = await prisma.videoInspiration.findMany({
      where: { title: { contains: tag } },
      orderBy: { title: 'asc' },
    });
    expect(rows.length).toBe(2);
    // 建议态落库：status=candidate（不直接 active）、来源系统身份、AI 检索非同行
    expect(rows.every((r) => r.status === 'candidate')).toBe(true);
    expect(rows.every((r) => r.createdBy === 'inspiration-scan')).toBe(true);
    expect(rows.every((r) => r.isPeer === false)).toBe(true);
    expect(rows.some((r) => r.title === `贴膜师傅第一视角施工记录${tag}`)).toBe(true);
    // 幂等键已写
    expect(await prisma.systemMeta.findUnique({ where: { key: doneKey } })).not.toBeNull();

    // 当日再跑：already-done，不再提交 AI、不再新增
    const again = await scheduler.autoScanOnce();
    expect(again.generated).toBe(false);
    expect(again.reason).toBe('already-done');
    expect(gateway.submitted.length).toBe(1);
    expect(await prisma.videoInspiration.count({ where: { title: { contains: tag } } })).toBe(2);
  });

  it('title 查重：与既有 active 同名的候选跳过，只落不重复的', async () => {
    // 既有 active 灵感与 AI 候选第一条同名（人工已录入过同款）
    await prisma.videoInspiration.create({
      data: {
        platform: '抖音',
        title: `贴膜师傅第一视角施工记录${tag}`,
        hookText: '人工录入的同名参考',
        structure: '人工结构',
        status: 'active',
        createdBy: salesId,
      },
    });

    const res = await scheduler.autoScanOnce();
    expect(res.generated).toBe(true);
    expect(res.created).toBe(1); // 第二条候选照落，第一条撞名跳过
    const rows = await prisma.videoInspiration.findMany({
      where: { title: `贴膜师傅第一视角施工记录${tag}` },
    });
    expect(rows.length).toBe(1); // 同名不双录
    expect(rows[0].status).toBe('active'); // 人工那条原样保留
    expect(
      await prisma.videoInspiration.count({
        where: { title: { contains: tag }, status: 'candidate' },
      }),
    ).toBe(1);
  });

  it('P3-F04 并发重入：在途扫描时第二个触发不发第二次 AI 调用（在途互斥）', async () => {
    // 评测实锤：真实扫描跨 11:00 整点巡检重入建了第二个任务；受控并发复现
    // 2 次 AI 调用、2 条同名候选（幂等键在完成后才写，查重非原子）
    const [a, b] = await Promise.all([scheduler.autoScanOnce(), scheduler.autoScanOnce()]);
    // 恰好一个真跑、另一个 in-flight 跳过（谁先谁后不确定，断言集合语义）
    expect([a.reason, b.reason].includes('in-flight')).toBe(true);
    expect(gateway.submitted.length).toBe(1); // AI 只提交一次
    const done = a.generated ? a : b;
    expect(done.created).toBe(2);
    // 同名候选不双录（互斥后查重天然原子）
    expect(await prisma.videoInspiration.count({ where: { title: { contains: tag } } })).toBe(2);
    expect(await prisma.systemMeta.findUnique({ where: { key: doneKey } })).not.toBeNull();
  });

  it('AI 失败不写幂等键（下小时重试语义）', async () => {
    gateway.broken = true;
    const res = await scheduler.autoScanOnce();
    expect(res.generated).toBe(false);
    expect(res.reason).toBe('error');
    expect(await prisma.systemMeta.findUnique({ where: { key: doneKey } })).toBeNull();
    expect(await prisma.videoInspiration.count({ where: { title: { contains: tag } } })).toBe(0);
  });

  it('堆积护栏：待处理 candidate ≥20 → 本轮跳过但仍写幂等键（跳过也算当日完成）', async () => {
    // 播种 20 条候选（直接落库，标题带 tag 隔离）
    await prisma.videoInspiration.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        platform: '抖音',
        title: `堆积候选样本${i}${tag}`,
        hookText: '钩子',
        structure: '结构',
        status: 'candidate',
        createdBy: salesId,
      })),
    });

    const res = await scheduler.autoScanOnce();
    expect(res.generated).toBe(true);
    expect(res.created).toBe(0);
    expect(res.reason).toBe('candidate-backlog');
    // 未触达 AI 也未新增，但幂等键已写（当日不再反复重查）
    expect(gateway.submitted.length).toBe(0);
    expect(await prisma.videoInspiration.count({ where: { title: { contains: tag } } })).toBe(20);
    expect(await prisma.systemMeta.findUnique({ where: { key: doneKey } })).not.toBeNull();
    // 同日再跑：直接 already-done（不会因为堆积继续撞 AI 通道）
    const again = await scheduler.autoScanOnce();
    expect(again.reason).toBe('already-done');
  });

  it('采纳/忽略：adopt → active、dismiss → archived；重复 adopt 409；审计留痕', async () => {
    await scheduler.autoScanOnce();
    const rows = await prisma.videoInspiration.findMany({
      where: { title: { contains: tag }, status: 'candidate' },
    });
    expect(rows.length).toBe(2);

    const post = (url: string, token: string) =>
      request(app.getHttpServer() as Server)
        .post(url)
        .set('Authorization', `Bearer ${token}`);

    // 采纳第一条 → active
    const adopted = await post(
      `/api/v1/marketing/video/inspirations/${rows[0].id}/adopt`,
      salesToken,
    ).expect(200);
    expect((adopted.body as { status: string }).status).toBe('active');
    // 忽略第二条 → archived
    const dismissed = await post(
      `/api/v1/marketing/video/inspirations/${rows[1].id}/dismiss`,
      bossToken,
    ).expect(200);
    expect((dismissed.body as { status: string }).status).toBe('archived');

    // 重复采纳（已 active）→ 409 终态防重；对 archived 再 adopt 也 409
    await post(`/api/v1/marketing/video/inspirations/${rows[0].id}/adopt`, salesToken).expect(409);
    await post(`/api/v1/marketing/video/inspirations/${rows[1].id}/adopt`, salesToken).expect(409);
    // 不存在 404
    await post('/api/v1/marketing/video/inspirations/nonexistent-id/adopt', salesToken).expect(404);

    // 审计留痕（采纳/忽略均写）
    const adoptedAudit = await prisma.auditLog.findFirst({
      where: {
        objectType: 'video_inspiration',
        objectId: rows[0].id,
        action: 'video_inspiration.adopted',
      },
    });
    expect(adoptedAudit).not.toBeNull();
    expect(adoptedAudit!.before as object).toMatchObject({ status: 'candidate' });
    expect(adoptedAudit!.after as object).toMatchObject({ status: 'active' });
    const dismissedAudit = await prisma.auditLog.count({
      where: {
        objectType: 'video_inspiration',
        objectId: rows[1].id,
        action: 'video_inspiration.dismissed',
      },
    });
    expect(dismissedAudit).toBe(1);
  });

  it('权限：记录员（无 m02:edit）adopt/dismiss → 403；列表 status=candidate 筛选可用', async () => {
    await scheduler.autoScanOnce();
    const rows = await prisma.videoInspiration.findMany({
      where: { title: { contains: tag }, status: 'candidate' },
    });
    expect(rows.length).toBe(2);

    await request(app.getHttpServer() as Server)
      .post(`/api/v1/marketing/video/inspirations/${rows[0].id}/adopt`)
      .set('Authorization', `Bearer ${recorderToken}`)
      .expect(403);
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/marketing/video/inspirations/${rows[0].id}/dismiss`)
      .set('Authorization', `Bearer ${recorderToken}`)
      .expect(403);

    // 列表 status=candidate 精确筛到本轮候选；status=active 不含候选
    const cand = await request(app.getHttpServer() as Server)
      .get('/api/v1/marketing/video/inspirations?status=candidate')
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    const candRows = (cand.body as Array<{ title: string }>).filter((r) => r.title.includes(tag));
    expect(candRows.length).toBe(2);
    const act = await request(app.getHttpServer() as Server)
      .get('/api/v1/marketing/video/inspirations?status=active')
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    expect(
      ((act.body as Array<{ title: string }>) ?? []).filter((r) => r.title.includes(tag)).length,
    ).toBe(0);
  });
});
