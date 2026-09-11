import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface RvRow {
  id: string;
  customerId: string | null;
  leadId: string | null;
  workOrderId: string | null;
  score: number;
  content: string | null;
  reviewedAt: string;
  createdBy: string | null;
  createdAt: string;
}

/** 客户评价登记集成测试（M09 · 缺口补齐批次 Task 2）：交付后评分与评语，
 * append-only——仅 GET 列表 + POST 创建，无 PATCH/DELETE 端点。 */
describe('客户评价登记（M09 · 缺口补齐批次）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  // 每次运行唯一 tag：测试库数据跨运行残留，content/单号用 tag 隔离（同模块既有套件同手法）
  const tag = Math.random().toString(36).slice(2, 8);
  let bossToken = '';
  let salesToken = '';
  let salesId = '';
  let recorderToken = '';
  let workOrderId = '';
  let customerId = '';

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

  const api = () => request(app.getHttpServer() as Server);

  const createRv = (token: string, extra: Record<string, unknown>) =>
    api().post('/api/v1/aftercare/reviews').set('Authorization', `Bearer ${token}`).send(extra);

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    bossToken = (await mkUser(uniqueUsername('m09rv_boss'), 'boss')).token;
    const sales = await mkUser(uniqueUsername('m09rv_sales'), 'sales_ops');
    salesToken = sales.token;
    salesId = sales.id;
    recorderToken = (await mkUser(uniqueUsername('m09rv_recorder'), 'recorder')).token;
    // 载体：prisma 直建 work_order 与客户档案（均含 tag）
    workOrderId = (
      await prisma.workOrder.create({
        data: {
          orderNo: `W-${tag}-RV01`,
          serviceItem: 'DM10 全车隔热膜',
          stage: 'delivered',
          deliveredAt: new Date(),
        },
      })
    ).id;
    customerId = (
      await prisma.customer.create({
        data: { name: `评价客户${tag}`, phone: `138${tag}00`.slice(0, 11) },
      })
    ).id;
  });

  afterAll(async () => {
    // 清理口径：评价按 content 含 tag 清扫；客户/工单按 tag
    await prisma.customerReview.deleteMany({ where: { content: { contains: tag } } });
    await prisma.customer.deleteMany({ where: { name: { contains: tag } } });
    await prisma.workOrder.deleteMany({ where: { orderNo: { contains: tag } } });
    await app.close();
  });

  it('POST 评价创建 → 201；score 边界 1/5 合法，0/6 拒绝 400', async () => {
    const res = await createRv(salesToken, {
      workOrderId,
      customerId,
      score: 5,
      content: `服务很满意${tag}`,
    }).expect(201);
    const body = res.body as RvRow;
    expect(body.id).toBeTruthy();
    expect(body.score).toBe(5);
    expect(body.content).toBe(`服务很满意${tag}`);
    expect(body.workOrderId).toBe(workOrderId);
    expect(body.customerId).toBe(customerId);
    expect(body.reviewedAt).toBeTruthy();
    expect(body.createdBy).toBe(salesId);

    // 审计留痕（S11 可追溯）：review.created / customer_review
    const audit = await prisma.auditLog.findFirst({
      where: { objectType: 'customer_review', objectId: body.id, action: 'review.created' },
    });
    expect(audit?.actorId).toBe(salesId);

    // score 下边界 1 合法
    await createRv(salesToken, { workOrderId, score: 1, content: `勉强及格${tag}` }).expect(201);
    // score 越界 0 / 6 → 400 VALIDATION_FAILED
    const tooLow = await createRv(salesToken, { workOrderId, score: 0, content: tag }).expect(400);
    expect((tooLow.body as { code: string }).code).toBe('VALIDATION_FAILED');
    const tooHigh = await createRv(salesToken, { workOrderId, score: 6, content: tag }).expect(400);
    expect((tooHigh.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('GET 列表按 reviewedAt desc——新评价在前', async () => {
    // prisma 直建两条历史评价（显式 reviewedAt），再经 API 建一条（reviewedAt≈now）
    const oldRv = await prisma.customerReview.create({
      data: {
        workOrderId,
        score: 3,
        content: `历史评价旧${tag}`,
        reviewedAt: new Date(Date.now() - 2 * 3600 * 1000),
        createdBy: salesId,
      },
    });
    const newRv = await prisma.customerReview.create({
      data: {
        workOrderId,
        score: 4,
        content: `历史评价新${tag}`,
        reviewedAt: new Date(Date.now() - 1 * 3600 * 1000),
        createdBy: salesId,
      },
    });
    const created = await createRv(bossToken, {
      workOrderId,
      customerId,
      score: 5,
      content: `最新评价${tag}`,
    }).expect(201);
    const apiRvId = (created.body as RvRow).id;

    // 增量口径：只断言本套件三条的相对顺序（最新在前）
    const list = await api()
      .get('/api/v1/aftercare/reviews')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    const rows = list.body as RvRow[];
    const idxApi = rows.findIndex((v) => v.id === apiRvId);
    const idxNew = rows.findIndex((v) => v.id === newRv.id);
    const idxOld = rows.findIndex((v) => v.id === oldRv.id);
    expect(idxApi).toBeGreaterThanOrEqual(0);
    expect(idxApi).toBeLessThan(idxNew);
    expect(idxNew).toBeLessThan(idxOld);
  });

  it('recorder 无 m09 权限 → 列表/创建 403', async () => {
    await api()
      .get('/api/v1/aftercare/reviews')
      .set('Authorization', `Bearer ${recorderToken}`)
      .expect(403);
    await createRv(recorderToken, { workOrderId, score: 4, content: `越权评价${tag}` }).expect(403);
  });

  it('append-only：无 PATCH/DELETE 端点 → 404', async () => {
    const created = await createRv(salesToken, {
      workOrderId,
      score: 4,
      content: `不可改评价${tag}`,
    }).expect(201);
    const id = (created.body as RvRow).id;

    await api()
      .patch(`/api/v1/aftercare/reviews/${id}`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ score: 1 })
      .expect(404);
    await api()
      .delete(`/api/v1/aftercare/reviews/${id}`)
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(404);

    // 未注册路由：原样保留（DB 中未被改动）
    const row = await prisma.customerReview.findUniqueOrThrow({ where: { id } });
    expect(row.score).toBe(4);
  });
});
