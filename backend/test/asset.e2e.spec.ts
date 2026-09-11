import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';

import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AiTaskRegistry } from '../src/modules/ai-dispatch/ai-dispatch.registry';
import type {
  GatewayRunResult,
  OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import { AssetService } from '../src/modules/asset/asset.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

// ConfigModule.forRoot 在 AppModule 导入时即对环境求值（早于 beforeAll），
// 必须在 vi.hoisted 里抢先将 WG_IMPORT_WATCH_DIR 指向临时目录（同 ai-cost.spec 手法）。
// 临时目录在测试内创建，套件结束删除；不设真实 uploads/inbox，避免测试污染开发目录。
const inboxPaths = vi.hoisted(() => {
  const base = `/tmp/wg-inbox-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const watchDir = `${base}/inbox`;
  process.env.WG_IMPORT_WATCH_DIR = watchDir;
  return { base, watchDir };
});

interface AssetBody {
  id: string;
  kind: string;
  title: string;
  filePath: string;
  carModel: string | null;
  productModel: string | null;
  stage: string | null;
  technicianName: string | null;
  source: string | null;
  licensed: boolean;
  workOrderId: string | null;
  createdBy: string;
  fileHash?: string | null;
  thumbPath?: string | null;
  mediaType?: string;
  tags?: string[];
}

/** 批量上传统计报告（v1.5 T11） */
interface BatchReport {
  created: Array<{ id: string; title: string }>;
  skippedDuplicate: string[];
  failed: Array<{ name: string; reason: string }>;
}

interface ErrorBody {
  code: string;
  message?: string;
}

/** 生成确定性但可区分的小 png（不同背景色 → 不同字节 → 不同 hash） */
function makePng(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
}

/** T13 AI 标签建议假网关：asset.suggest_tags 回显合法 tags 输出（走通 done 态），
 * 其余 taskType 同 buildApp 缺省回显；记录最近一次提交载荷供契约断言 */
class SuggestTagsGateway implements OpenClawGateway {
  lastSubmit?: SubmitTaskRequest;

  submit(req: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.lastSubmit = req;
    const output =
      req.taskType === 'asset.suggest_tags'
        ? { tags: ['窗膜', 'DM04'] }
        : { greeting: '你好（fake）', model: 'fake' };
    return Promise.resolve({ status: 'done', output });
  }

  health(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** AI 任务响应体（T13 suggest-tags 冒烟断言用） */
interface AiTaskBody {
  id: string;
  taskType: string;
  status: string;
  output: unknown;
}

/** 素材库集成测试（V2.3b Task2）：上传白名单/落盘/列表筛选/详情/文件服务鉴权/权限边界 */
describe('素材库（V2.3b）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  const tag = Math.random().toString(36).slice(2, 8);
  let managerToken = '';
  let managerId = '';
  let salesToken = '';

  let woId = '';
  let uploaded: AssetBody | undefined; // ① 成功上传的 jpg 实体
  let bossUserId = '';
  const gateway = new SuggestTagsGateway();
  // 测试隔离：本套件经 suggest-tags 端点创建的 AI 任务行统一登记，afterAll 全量清理
  const aiTaskIds: string[] = [];

  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  // %PDF-1.4 头字节即满足 sendFile/multer 的最小合法样本（白名单按 MIME 判定）
  const pdfBytes = Buffer.from('%PDF-1.4\n%%EOF\n');

  const api = (method: 'get' | 'post' | 'patch' | 'delete', url: string, token?: string) => {
    const req = request(app.getHttpServer() as Server)[method](url);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  const mkUser = async (uname: string, role: string): Promise<{ token: string; id: string }> => {
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
    return { token: (res.body as { accessToken: string }).accessToken, id: user.id };
  };

  beforeAll(async () => {
    app = await buildApp(gateway);
    // 停掉本实例的定时任务（含 T12 scanInbox @Interval）：用例只走直调断言，不赌定时器
    const registry = app.get(SchedulerRegistry);
    for (const job of registry.getCronJobs().values()) void job.stop();
    for (const name of registry.getIntervals()) {
      clearInterval(registry.getInterval(name) as NodeJS.Timeout);
    }
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const manager = await mkUser(uniqueUsername('as_mgr'), 'store_manager');
    managerToken = manager.token;
    managerId = manager.id;
    salesToken = (await mkUser(uniqueUsername('as_sales'), 'sales_ops')).token;

    // 可选关联的施工单（元数据全量用）
    const wo = await prisma.workOrder.create({
      data: { orderNo: `W-AS-${tag}-0001`, stage: 'in_progress' },
    });
    woId = wo.id;
  });

  afterAll(async () => {
    // 按本次运行 tag 清理（落盘文件同 photos 先例不回收，实体不入 git/库）
    await prisma.asset.deleteMany({ where: { title: { contains: tag } } });
    await prisma.workOrder.deleteMany({ where: { orderNo: { contains: `W-AS-${tag}` } } });
    if (bossUserId) await prisma.notification.deleteMany({ where: { userId: bossUserId } });
    if (aiTaskIds.length > 0) {
      await prisma.aiTaskEvent.deleteMany({ where: { taskId: { in: aiTaskIds } } });
      await prisma.aiTask.deleteMany({ where: { id: { in: aiTaskIds } } });
    }
    rmSync(inboxPaths.base, { recursive: true, force: true });
    delete process.env.WG_IMPORT_WATCH_DIR;
    await app.close();
  });

  it('店长 multipart 上传 png（元数据全）→201、落盘 assets/ 子目录、filePath 入库', async () => {
    // 非白名单 txt → 400（白名单拦截）
    await api('post', '/api/v1/assets', managerToken)
      .field('kind', 'finished')
      .field('title', `不应该出现${tag}`)
      .attach('file', Buffer.from('not allowed'), {
        filename: 'a.txt',
        contentType: 'text/plain',
      })
      .expect(400);
    // 缺文件 → 400
    await api('post', '/api/v1/assets', managerToken)
      .field('kind', 'finished')
      .field('title', `缺文件${tag}`)
      .expect(400);

    const res = await api('post', '/api/v1/assets', managerToken)
      .field('kind', 'finished')
      .field('title', `完工案例${tag}`)
      .field('carModel', `Model Y${tag}`)
      .field('productModel', `DM10${tag}`)
      .field('stage', '全车贴膜完成')
      .field('technicianName', '技师张三')
      .field('source', '客户授权回流')
      .field('licensed', 'true')
      .field('workOrderId', woId)
      .attach('file', png1x1, { filename: '前挡.png', contentType: 'image/png' })
      .expect(201);
    uploaded = res.body as AssetBody;
    expect(uploaded.kind).toBe('finished');
    expect(uploaded.title).toBe(`完工案例${tag}`);
    expect(uploaded.carModel).toBe(`Model Y${tag}`);
    expect(uploaded.productModel).toBe(`DM10${tag}`);
    expect(uploaded.stage).toBe('全车贴膜完成');
    expect(uploaded.technicianName).toBe('技师张三');
    expect(uploaded.source).toBe('客户授权回流');
    expect(uploaded.licensed).toBe(true);
    expect(uploaded.workOrderId).toBe(woId);
    expect(uploaded.createdBy).toBe(managerId);
    // 落盘 assets/ 子目录、文件名 asset- 前缀、字节一致
    expect(uploaded.filePath).toContain(`assets`);
    // 时间戳 base36（防手机号正则误伤，见 asset.service ingestFile 注释）
    expect(uploaded.filePath.split(/[/\\]/).at(-1)).toMatch(/^asset-[0-9a-z]+-[0-9a-f]+\.png$/);
    expect(existsSync(uploaded.filePath)).toBe(true);
    expect(readFileSync(uploaded.filePath).equals(png1x1)).toBe(true);
    // filePath 入库（响应与库一致）
    const row = await prisma.asset.findUniqueOrThrow({ where: { id: uploaded.id } });
    expect(row.filePath).toBe(uploaded.filePath);
    expect(row.licensed).toBe(true);
  });

  it('列表：kind 筛选 + keyword（title/carModel ILIKE）', async () => {
    // 第二条：产品资料 PDF（carModel 空，productModel 命中不应进 keyword 结果）
    const pdf = await api('post', '/api/v1/assets', managerToken)
      .field('kind', 'product_doc')
      .field('title', `产品手册${tag}`)
      .field('productModel', `DM26${tag}`)
      .attach('file', pdfBytes, { filename: 'a.pdf', contentType: 'application/pdf' })
      .expect(201);
    const pdfAsset = pdf.body as AssetBody;
    expect(pdfAsset.kind).toBe('product_doc');
    expect(pdfAsset.licensed).toBe(false); // licensed 默认 false

    // kind 筛选：仅 finished
    const byKind = await api('get', '/api/v1/assets?kind=finished', managerToken).expect(200);
    const kindIds = (byKind.body as AssetBody[]).map((a) => a.id);
    expect(kindIds).toContain(uploaded!.id);
    expect(kindIds).not.toContain(pdfAsset.id);

    // keyword 命中 carModel（title 不含该片段）
    const byCar = await api('get', `/api/v1/assets?keyword=Model Y${tag}`, managerToken).expect(
      200,
    );
    const carIds = (byCar.body as AssetBody[]).map((a) => a.id);
    expect(carIds).toEqual([uploaded!.id]);

    // keyword 命中 title
    const byTitle = await api('get', `/api/v1/assets?keyword=产品手册${tag}`, managerToken).expect(
      200,
    );
    const titleIds = (byTitle.body as AssetBody[]).map((a) => a.id);
    expect(titleIds).toContain(pdfAsset.id);
    expect(titleIds).not.toContain(uploaded!.id);
  });

  it('详情：GET /assets/:id 返回完整元数据', async () => {
    const res = await api('get', `/api/v1/assets/${uploaded!.id}`, managerToken).expect(200);
    const body = res.body as AssetBody;
    expect(body.id).toBe(uploaded!.id);
    expect(body.title).toBe(`完工案例${tag}`);
    expect(body.carModel).toBe(`Model Y${tag}`);
    // 伪造 id → 404
    await api('get', '/api/v1/assets/nonexistent-id', managerToken).expect(404);
  });

  it('文件服务：带 token 200 且 Content-Type 正确、匿名 401、伪造 id 404', async () => {
    // png 素材
    const img = await api('get', `/api/v1/assets/${uploaded!.id}/file`, managerToken).expect(200);
    expect(img.headers['content-type']).toContain('image/png');
    expect((img.body as Buffer).equals(png1x1)).toBe(true);
    // pdf 素材（同轮上传的产品手册）
    const list = await api('get', `/api/v1/assets?keyword=产品手册${tag}`, managerToken).expect(
      200,
    );
    const pdfId = (list.body as AssetBody[])[0].id;
    const pdfRes = await api('get', `/api/v1/assets/${pdfId}/file`, managerToken).expect(200);
    expect(pdfRes.headers['content-type']).toContain('application/pdf');
    // 匿名 → 401
    await request(app.getHttpServer() as Server)
      .get(`/api/v1/assets/${uploaded!.id}/file`)
      .expect(401);
    // 伪造 id → 404
    await api('get', '/api/v1/assets/nonexistent-id/file', managerToken).expect(404);
  });

  it('权限边界：sales(m06:view) 可列表/详情，但上传 403', async () => {
    await api('get', '/api/v1/assets', salesToken).expect(200);
    await api('get', `/api/v1/assets/${uploaded!.id}`, salesToken).expect(200);
    await api('get', `/api/v1/assets/${uploaded!.id}/file`, salesToken).expect(200);
    await api('post', '/api/v1/assets', salesToken)
      .field('kind', 'process')
      .field('title', `销售越权${tag}`)
      .attach('file', png1x1, { filename: 'x.png', contentType: 'image/png' })
      .expect(403);
    // 越权上传无副作用
    const leak = await prisma.asset.findFirst({ where: { title: `销售越权${tag}` } });
    expect(leak).toBeNull();
  });

  // —— v1.5 素材管线（T11）：hash 去重 / 缩略图 / 批量上传 ——

  it('批量上传去重：同内容文件第二次进入 skippedDuplicate', async () => {
    const buf = await makePng(11, 22, 33);
    const first = await api('post', '/api/v1/assets/batch', managerToken)
      .field('kind', 'finished')
      .field('title', `案例A-${tag}`)
      .attach('files', buf, { filename: `a-${tag}.png`, contentType: 'image/png' })
      .expect(201);
    const f = first.body as BatchReport;
    expect(f.created).toHaveLength(1);
    expect(f.created[0].title).toBe(`a-${tag}`); // title 取原文件名去扩展名
    expect(f.skippedDuplicate).toHaveLength(0);
    expect(f.failed).toHaveLength(0);
    // hash/thumbPath/mediaType 入库
    const row = await prisma.asset.findUniqueOrThrow({ where: { id: f.created[0].id } });
    expect(row.fileHash).toBeTruthy();
    expect(row.mediaType).toBe('image');
    expect(row.thumbPath).toBeTruthy();

    const second = await api('post', '/api/v1/assets/batch', managerToken)
      .field('kind', 'finished')
      .field('title', `案例A2-${tag}`)
      .attach('files', buf, { filename: `a2-${tag}.png`, contentType: 'image/png' })
      .expect(201);
    const s = second.body as BatchReport;
    expect(s.created).toHaveLength(0);
    expect(s.skippedDuplicate).toEqual([`a2-${tag}.png`]); // 报告口径为原始文件名
    expect(s.failed).toHaveLength(0);
  });

  it('批量上传带车型（2026-08-28）：carModel 应用于本批全部文件', async () => {
    const res = await api('post', '/api/v1/assets/batch', managerToken)
      .field('kind', 'finished')
      .field('carModel', '特斯拉Y')
      .attach('files', await makePng(61, 62, 63), {
        filename: `batch-car-1-${tag}.png`,
        contentType: 'image/png',
      })
      .attach('files', await makePng(64, 65, 66), {
        filename: `batch-car-2-${tag}.png`,
        contentType: 'image/png',
      })
      .expect(201);
    const report = res.body as BatchReport;
    expect(report.created).toHaveLength(2);
    for (const c of report.created) {
      const row = await prisma.asset.findUniqueOrThrow({ where: { id: c.id } });
      expect(row.carModel).toBe('特斯拉Y');
    }
  });

  it('单文件上传重复内容 → 409 CONFLICT', async () => {
    const buf = await makePng(44, 55, 66);
    await api('post', '/api/v1/assets', managerToken)
      .field('kind', 'process')
      .field('title', `单传A${tag}`)
      .attach('file', buf, { filename: 's.png', contentType: 'image/png' })
      .expect(201);
    const res = await api('post', '/api/v1/assets', managerToken)
      .field('kind', 'process')
      .field('title', `单传B${tag}`)
      .attach('file', buf, { filename: 's2.png', contentType: 'image/png' })
      .expect(409);
    expect((res.body as ErrorBody).code).toBe('CONFLICT');
    expect((res.body as ErrorBody).message).toContain('素材已存在');
    // 未产生第二条
    const count = await prisma.asset.count({ where: { title: `单传B${tag}` } });
    expect(count).toBe(0);
  });

  it('批量上传：白名单外文件进 failed，视频放行且不生成缩略图', async () => {
    // 无文件 → 400
    await api('post', '/api/v1/assets/batch', managerToken).field('kind', 'finished').expect(400);

    const imgBuf = await makePng(77, 88, 99);
    const vidBuf = Buffer.from('fake-mp4-bytes'); // 白名单按 MIME 判定，内容不影响入库
    const res = await api('post', '/api/v1/assets/batch', managerToken)
      .field('kind', 'finished')
      .attach('files', Buffer.from('plain text'), {
        filename: `note-${tag}.txt`,
        contentType: 'text/plain',
      })
      .attach('files', imgBuf, { filename: `ok-${tag}.png`, contentType: 'image/png' })
      .attach('files', vidBuf, { filename: `clip-${tag}.mp4`, contentType: 'video/mp4' })
      .expect(201);
    const body = res.body as BatchReport;
    expect(body.failed).toEqual([{ name: `note-${tag}.txt`, reason: '不支持的文件类型' }]);
    expect(body.created).toHaveLength(2);
    expect(body.skippedDuplicate).toHaveLength(0);

    const videoItem = body.created.find((c) => c.title === `clip-${tag}`);
    expect(videoItem).toBeDefined();
    const videoRow = await prisma.asset.findUniqueOrThrow({ where: { id: videoItem!.id } });
    expect(videoRow.mediaType).toBe('video');
    expect(videoRow.thumbPath).toBeNull(); // 缩略图仅图片
  });

  it('批量上传：图片超 20MB 进 failed『超出大小限制』且不入库', async () => {
    // 刚好超限的最小尺寸（20MB+1B），multer 层 1GB 上限内放行，服务层按图片限额拒收
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1);
    const res = await api('post', '/api/v1/assets/batch', managerToken)
      .field('kind', 'finished')
      .attach('files', oversized, { filename: `big-${tag}.png`, contentType: 'image/png' })
      .expect(201);
    const body = res.body as BatchReport;
    expect(body.failed).toEqual([{ name: `big-${tag}.png`, reason: '超出大小限制' }]);
    expect(body.created).toHaveLength(0);
    expect(body.skippedDuplicate).toHaveLength(0);
    // 未入库
    const row = await prisma.asset.findFirst({ where: { title: `big-${tag}` } });
    expect(row).toBeNull();
  });

  it('批量上传超过 50 个文件被拒（400/422）', async () => {
    let req = api('post', '/api/v1/assets/batch', managerToken).field('kind', 'finished');
    for (let i = 0; i < 51; i++) {
      req = req.attach('files', png1x1, {
        filename: `f${i}-${tag}.png`,
        contentType: 'image/png',
      });
    }
    const res = await req;
    expect([400, 422]).toContain(res.status);
  });

  it('PATCH tags/licensed/title 生效留痕，sales 越权 403', async () => {
    const id = uploaded!.id;
    const res = await api('patch', `/api/v1/assets/${id}`, managerToken)
      .send({ tags: ['DM10', `Model Y${tag}`], licensed: true, stage: '收尾检查' })
      .expect(200);
    const body = res.body as AssetBody;
    expect(body.tags).toEqual(['DM10', `Model Y${tag}`]);
    expect(body.licensed).toBe(true);
    expect(body.stage).toBe('收尾检查');
    // 持久化
    const row = await prisma.asset.findUniqueOrThrow({ where: { id } });
    expect(row.tags).toEqual(['DM10', `Model Y${tag}`]);
    expect(row.licensed).toBe(true);
    // 留痕
    const audit = await prisma.auditLog.findFirst({
      where: { objectType: 'asset', objectId: id, action: 'asset.updated' },
    });
    expect(audit?.actorId).toBe(managerId);
    // 未提供字段不被清空
    expect(row.title).toBe(`完工案例${tag}`);
    // sales 无 m06:edit → 403
    await api('patch', `/api/v1/assets/${id}`, salesToken)
      .send({ tags: ['x'] })
      .expect(403);
    // 不存在 → 404
    await api('patch', '/api/v1/assets/nonexistent-id', managerToken)
      .send({ tags: ['x'] })
      .expect(404);
  });

  it('PATCH tags 超上限 400：个数>8 或单个>30 字', async () => {
    // -t 单测过滤时前置上传用例被跳过，现场补一条素材兜底（全套件跑则复用 uploaded）
    let targetId = uploaded?.id;
    if (!targetId) {
      const up = await api('post', '/api/v1/assets', managerToken)
        .field('kind', 'finished')
        .field('title', `标签超限${tag}`)
        .attach('file', png1x1, { filename: `tag-limit-${tag}.png`, contentType: 'image/png' })
        .expect(201);
      targetId = (up.body as AssetBody).id;
    }

    const tooMany = Array.from({ length: 9 }, (_, i) => `t${i}${tag}`);
    const r1 = await api('patch', `/api/v1/assets/${targetId}`, managerToken).send({
      tags: tooMany,
    });
    expect(r1.status).toBe(400);

    const tooLong = '甲'.repeat(31);
    const r2 = await api('patch', `/api/v1/assets/${targetId}`, managerToken).send({
      tags: [tooLong],
    });
    expect(r2.status).toBe(400);
  });

  it('PATCH /assets/batch 批量授权：一键授权/转内部计数返回、留痕、越权 403、空 ids 422', async () => {
    // 建 3 条素材作为批量对象
    const created = await api('post', '/api/v1/assets/batch', managerToken)
      .field('kind', 'finished')
      .attach('files', await makePng(210, 211, 212), {
        filename: `bl1-${tag}.png`,
        contentType: 'image/png',
      })
      .attach('files', await makePng(213, 214, 215), {
        filename: `bl2-${tag}.png`,
        contentType: 'image/png',
      })
      .attach('files', await makePng(216, 217, 218), {
        filename: `bl3-${tag}.png`,
        contentType: 'image/png',
      })
      .expect(201);
    const ids = (created.body as BatchReport).created.map((c) => c.id);
    expect(ids).toHaveLength(3);

    // 一键授权 3 条
    const batch = await api('patch', '/api/v1/assets/batch', managerToken)
      .send({ ids, licensed: true })
      .expect(200);
    expect((batch.body as { updated: number }).updated).toBe(3);
    let rows = await prisma.asset.findMany({ where: { id: { in: ids } } });
    expect(rows.every((r) => r.licensed)).toBe(true);

    // 转回内部
    const back = await api('patch', '/api/v1/assets/batch', managerToken)
      .send({ ids, licensed: false })
      .expect(200);
    expect((back.body as { updated: number }).updated).toBe(3);
    rows = await prisma.asset.findMany({ where: { id: { in: ids } } });
    expect(rows.some((r) => r.licensed)).toBe(false);

    // 单条审计留痕（批量动作不逐条记；findFirst 必带 orderBy——踩坑实录防旧记录干扰）
    const audit = await prisma.auditLog.findFirst({
      where: { objectType: 'asset', action: 'asset.licensed_batch' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.actorId).toBe(managerId);

    // 混入不存在 id：按实际命中计数返回，不整批失败
    const partial = await api('patch', '/api/v1/assets/batch', managerToken)
      .send({ ids: [ids[0], 'nonexistent-id'], licensed: true })
      .expect(200);
    expect((partial.body as { updated: number }).updated).toBe(1);

    // sales 无编辑位 → 403
    await api('patch', '/api/v1/assets/batch', salesToken)
      .send({ ids, licensed: true })
      .expect(403);
    // 空 ids → 拒绝（400/422 视校验层映射，同 51 文件超限用例口径）
    const empty = await api('patch', '/api/v1/assets/batch', managerToken).send({
      ids: [],
      licensed: true,
    });
    expect([400, 422]).toContain(empty.status);
  });

  it('DELETE /assets/:id：记录删除、文件挪回收目录、sales 403、不存在 404', async () => {
    // 上传一条带缩略图的 png 作为删除对象
    const up = await api('post', '/api/v1/assets', managerToken)
      .field('kind', 'finished')
      .field('title', `待删${tag}`)
      .attach('file', await makePng(230, 231, 232), {
        filename: `del-${tag}.png`,
        contentType: 'image/png',
      })
      .expect(201);
    const id = (up.body as AssetBody).id;
    const row = await prisma.asset.findUniqueOrThrow({ where: { id } });
    expect(row.thumbPath).toBeTruthy();

    // sales 无编辑位 → 403，记录未动
    await api('delete', `/api/v1/assets/${id}`, salesToken).expect(403);
    expect(await prisma.asset.findUnique({ where: { id } })).not.toBeNull();

    // 店长删除成功，详情随之 404
    await api('delete', `/api/v1/assets/${id}`, managerToken).expect(200);
    expect(await prisma.asset.findUnique({ where: { id } })).toBeNull();
    await api('get', `/api/v1/assets/${id}`, managerToken).expect(404);

    // 物理文件与缩略图挪入回收目录（id 前缀防同名覆盖）
    expect(existsSync(row.filePath)).toBe(false);
    expect(existsSync(row.thumbPath!)).toBe(false);
    const trashDir = path.join(process.env.WG_UPLOAD_DIR ?? 'uploads', '.trash-deleted');
    expect(existsSync(path.join(trashDir, `${id}-${path.basename(row.filePath)}`))).toBe(true);
    expect(existsSync(path.join(trashDir, `${id}-${path.basename(row.thumbPath!)}`))).toBe(true);

    // 审计留痕（findFirst 带 orderBy——踩坑实录口径）
    const audit = await prisma.auditLog.findFirst({
      where: { objectType: 'asset', action: 'asset.deleted' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.actorId).toBe(managerId);

    // 不存在 → 404
    await api('delete', '/api/v1/assets/nonexistent-id', managerToken).expect(404);
  });

  it('GET thumb：图片返回 webp 缩略图；无缩略图回退原文件', async () => {
    // 首测上传的 png 已生成缩略图
    const res = await api('get', `/api/v1/assets/${uploaded!.id}/thumb`, managerToken).expect(200);
    expect(res.headers['content-type']).toContain('image/webp');

    // 损坏 jpeg：过 MIME 白名单但 sharp 无法解码 → thumbPath=null → 回退原文件
    const bad = await api('post', '/api/v1/assets', managerToken)
      .field('kind', 'process')
      .field('title', `坏图${tag}`)
      .attach('file', Buffer.from('definitely-not-a-real-jpeg'), {
        filename: 'bad.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);
    const badBody = bad.body as AssetBody;
    expect(badBody.thumbPath ?? null).toBeNull();
    expect(badBody.mediaType).toBe('image');
    const fallback = await api('get', `/api/v1/assets/${badBody.id}/thumb`, managerToken).expect(
      200,
    );
    expect(fallback.headers['content-type']).toContain('image/jpeg');
    // 匿名 401、不存在 404
    await request(app.getHttpServer() as Server)
      .get(`/api/v1/assets/${badBody.id}/thumb`)
      .expect(401);
    await api('get', '/api/v1/assets/nonexistent-id/thumb', managerToken).expect(404);
  });

  // —— v1.5 T12：待入库文件夹扫描（watch 目录）——

  it('scanInbox 入库并分拣：成功移 processed、损坏移 failed、重复跳过、二次扫描不新增', async () => {
    const watchDir = inboxPaths.watchDir;
    // 子目录放重复内容文件，验证递归收集
    mkdirSync(path.join(watchDir, 'sub'), { recursive: true });
    const pngBuf = await makePng(101, 102, 103);
    writeFileSync(path.join(watchDir, `watch-ok-${tag}.png`), pngBuf);
    writeFileSync(path.join(watchDir, 'sub', `watch-dup-${tag}.jpg`), pngBuf); // 同内容不同名 → 重复跳过
    writeFileSync(path.join(watchDir, `watch-note-${tag}.txt`), 'not a media file'); // 扩展名白名单外
    writeFileSync(path.join(watchDir, `watch-empty-${tag}.png`), Buffer.alloc(0)); // 0 字节坏文件

    const boss = await mkUser(uniqueUsername('as_boss'), 'boss');
    bossUserId = boss.id;
    const before = await prisma.asset.count();

    await app.get(AssetService).scanInbox();

    // DB 恰多 1 条：title=原文件名去扩展名，createdBy=固定串 watch-import
    expect(await prisma.asset.count()).toBe(before + 1);
    const row = await prisma.asset.findFirst({ where: { title: `watch-ok-${tag}` } });
    expect(row).not.toBeNull();
    expect(row!.createdBy).toBe('watch-import');
    expect(row!.mediaType).toBe('image');
    // 2026-08-25 老板口径：inbox 投递默认完工案例；文件名「车型-序号」前缀解析 carModel
    expect(row!.kind).toBe('finished');
    expect(row!.carModel).toBe('watch');
    expect(await prisma.asset.findFirst({ where: { title: `watch-dup-${tag}` } })).toBeNull();

    // 分拣：成功/重复 → watchDir 同级 inbox-processed/YYYY-MM/；失败 → inbox-failed/
    const d = new Date();
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const processedDir = path.join(inboxPaths.base, 'inbox-processed', ym);
    const failedDir = path.join(inboxPaths.base, 'inbox-failed');
    expect(existsSync(path.join(processedDir, `watch-ok-${tag}.png`))).toBe(true);
    expect(existsSync(path.join(processedDir, `watch-dup-${tag}.jpg`))).toBe(true);
    expect(existsSync(path.join(failedDir, `watch-note-${tag}.txt`))).toBe(true);
    expect(existsSync(path.join(failedDir, `watch-empty-${tag}.png`))).toBe(true);
    // 原位置已清走
    expect(existsSync(path.join(watchDir, `watch-ok-${tag}.png`))).toBe(false);
    expect(existsSync(path.join(watchDir, 'sub', `watch-dup-${tag}.jpg`))).toBe(false);

    // 汇总通知发给 boss
    const notes = await prisma.notification.findMany({
      where: { userId: boss.id, kind: 'asset_import_done' },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('素材入库完成：新增 1 / 跳过重复 1 / 失败 2');
    expect(notes[0].link).toBe('/assets');
    expect(notes[0].sourceType).toBe('asset_import');

    // 幂等：二次扫描无文件可处理 → 不新增、不重复通知
    await app.get(AssetService).scanInbox();
    expect(await prisma.asset.count()).toBe(before + 1);
    const notesAfter = await prisma.notification.findMany({
      where: { userId: boss.id, kind: 'asset_import_done' },
    });
    expect(notesAfter).toHaveLength(1);
  });

  it('scanInbox 子文件夹分组（2026-08-28）：文件夹名=车型，优先于文件名前缀；原文件名不动', async () => {
    // 小白批量导入路径：访达按车型建文件夹、整堆拖进收件箱——无需按「车型-序号」重命名。
    // 计数按本用例唯一 title 圈定（共享测试库并行套件会同时写 asset 行，全表 count 有竞态）
    const watchDir = inboxPaths.watchDir;
    const t1 = `folder${tag}a`;
    const t2 = `前缀车-${tag}`;
    const t3 = `folder${tag}b`;
    const titles = [t1, t2, t3];
    mkdirSync(path.join(watchDir, '问界M9'), { recursive: true });
    mkdirSync(path.join(watchDir, '极氪9X', 'detail'), { recursive: true });
    // 图片字节按 run 唯一（tag 派生）：共享测试库有历史遗留行，固定字节的 PNG 会撞哈希被判重复。
    // 派生值 mod 251：背景色不超 255 被 sharp 钳位（乘法放大后两文件同变纯白必撞，实测教训）
    const px = (fileIdx: number, i: number) =>
      (tag.charCodeAt((i + fileIdx * 3) % tag.length) + i * 37 + fileIdx * 101) % 251;
    writeFileSync(
      path.join(watchDir, '问界M9', `${t1}.png`),
      await makePng(px(0, 0), px(0, 1), px(0, 2)),
    );
    // 文件名本身带「车型-」前缀时文件夹优先
    writeFileSync(
      path.join(watchDir, '问界M9', `${t2}.png`),
      await makePng(px(1, 0), px(1, 1), px(1, 2)),
    );
    // 更深嵌套取第一级目录
    writeFileSync(
      path.join(watchDir, '极氪9X', 'detail', `${t3}.png`),
      await makePng(px(2, 0), px(2, 1), px(2, 2)),
    );

    await app.get(AssetService).scanInbox();

    expect(await prisma.asset.count({ where: { title: { in: titles } } })).toBe(3);
    const m9 = await prisma.asset.findFirstOrThrow({ where: { title: t1 } });
    expect(m9.carModel).toBe('问界M9');
    expect(m9.kind).toBe('finished');
    const prefix = await prisma.asset.findFirstOrThrow({ where: { title: t2 } });
    expect(prefix.carModel).toBe('问界M9'); // 文件夹优先于文件名「前缀车」
    const nested = await prisma.asset.findFirstOrThrow({ where: { title: t3 } });
    expect(nested.carModel).toBe('极氪9X'); // 深层嵌套取第一级目录
  });

  // —— v1.5 T13：AI 标签建议技能（asset.suggest_tags，A09 待批准发布，本任务仅登记）——

  it('asset.suggest_tags 已注册且输出 schema 校验 tags 数组', () => {
    const def = app.get(AiTaskRegistry).get('asset.suggest_tags');
    expect(def.skillName).toBe('skill-asset-suggest-tags');
    const parsed = def.outputSchema.parse({ tags: ['窗膜', 'DM04'] }) as { tags: string[] };
    expect(parsed.tags).toHaveLength(2);
    expect(() => def.outputSchema.parse({ tags: 'x' })).toThrow();
    // 上限契约：≤8 个、单项 ≤30 字
    expect(() =>
      def.outputSchema.parse({ tags: Array.from({ length: 9 }, (_, i) => `t${i}`) }),
    ).toThrow();
    expect(() => def.outputSchema.parse({ tags: ['x'.repeat(31)] })).toThrow();
  });

  it('POST suggest-tags：素材不存在 404、sales 越权 403、店长发起同步闭环 done', async () => {
    // 素材不存在 → 404
    await api('post', '/api/v1/assets/nonexistent-id/suggest-tags', managerToken).expect(404);
    // sales 仅 m06:view，无 m06:edit → 403
    await api('post', `/api/v1/assets/${uploaded!.id}/suggest-tags`, salesToken).expect(403);

    const row = await prisma.asset.findUniqueOrThrow({ where: { id: uploaded!.id } });
    const res = await api(
      'post',
      `/api/v1/assets/${uploaded!.id}/suggest-tags`,
      managerToken,
    ).expect(201);
    const task = res.body as AiTaskBody;
    aiTaskIds.push(task.id);
    expect(task.taskType).toBe('asset.suggest_tags');
    expect(task.status).toBe('done');
    expect(task.output).toEqual({ tags: ['窗膜', 'DM04'] });

    // 提交载荷契约：file=basename(filePath) 取库不取参数，元数据随素材现状透传
    // （键名 file 而非 fileName：脱敏器将 *name 键按人名脱敏，见 controller 注释）
    expect(gateway.lastSubmit).toBeDefined();
    expect(gateway.lastSubmit!.taskType).toBe('asset.suggest_tags');
    expect(gateway.lastSubmit!.context).toEqual({
      file: path.basename(row.filePath),
      kind: row.kind,
      carModel: row.carModel,
      productModel: row.productModel,
      stage: row.stage,
      title: row.title,
    });
    expect(gateway.lastSubmit!.constraints).toEqual({
      boundary: '仅输出标签数组，不编造事实，不访问工具',
    });
  });
});
