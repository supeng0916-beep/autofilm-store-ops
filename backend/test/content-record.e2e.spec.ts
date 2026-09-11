import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface ContentRow {
  id: string;
  contentKey: string;
  title: string;
  platform: string | null;
  publishedAt: string | null;
  costFen: number;
  viewsCount: number | null;
  likesCount: number | null;
  commentsCount: number | null;
  note: string | null;
  createdBy: string | null;
}

/** 内容台账集成测试（M02 · 批次2）：登记已发布内容——contentKey 归因键唯一（撞键
 * P2002 转 409）、列表 publishedAt desc 空值排最后、互动数据/备注可改而归因键不可改、
 * 写口径 m02:edit ∪ m02:approve、审计 content_record.created/updated 留痕 */
describe('内容台账（M02 · 批次2）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  // 每次运行唯一 tag：测试库数据跨运行残留，台账以 contentKey 含 tag 隔离与清扫
  const tag = Math.random().toString(36).slice(2, 8);
  let bossToken = '';
  let bossId = '';
  let managerToken = '';
  let salesToken = '';
  let recorderToken = '';
  let baseId = ''; // PATCH 用例专用台账行

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

  const createRecord = (token: string, extra: Record<string, unknown>) =>
    api()
      .post('/api/v1/marketing/content-records')
      .set('Authorization', `Bearer ${token}`)
      .send(extra);

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const boss = await mkUser(uniqueUsername('m02cr_boss'), 'boss');
    bossToken = boss.token;
    bossId = boss.id;
    managerToken = (await mkUser(uniqueUsername('m02cr_manager'), 'store_manager')).token;
    salesToken = (await mkUser(uniqueUsername('m02cr_sales'), 'sales_ops')).token;
    recorderToken = (await mkUser(uniqueUsername('m02cr_recorder'), 'recorder')).token;
  });

  afterAll(async () => {
    // 清理口径：台账按 contentKey 含 tag 清扫（仅测试库清扫本套件残留）
    await prisma.contentRecord.deleteMany({ where: { contentKey: { contains: tag } } });
    await app.close();
  });

  it('POST 创建 → 201（contentKey 必填且去空格、costFen 缺省 0）', async () => {
    // contentKey 前后空格一律 trim 后落库（归因键与导入客资 contentId 精确匹配）
    const created = await createRecord(bossToken, {
      contentKey: `  cr-${tag}-a  `,
      title: `演示品牌DM10施工实录${tag}`,
      platform: '抖音',
      publishedAt: '2026-08-18T00:00:00.000Z',
      viewsCount: 100,
    }).expect(201);
    const row = created.body as ContentRow;
    expect(row.id).toBeTruthy();
    expect(row.contentKey).toBe(`cr-${tag}-a`);
    expect(row.title).toBe(`演示品牌DM10施工实录${tag}`);
    expect(row.costFen).toBe(0);
    expect(row.viewsCount).toBe(100);
    expect(row.createdBy).toBe(bossId);

    // contentKey 缺失 → 400；纯空格（trim 后为空）→ 400；title 缺失 → 400
    await createRecord(bossToken, { title: `缺归因键${tag}` }).expect(400);
    await createRecord(bossToken, { contentKey: '   ', title: `纯空格键${tag}` }).expect(400);
    await createRecord(bossToken, { contentKey: `cr-${tag}-no-title` }).expect(400);
  });

  it('重复 contentKey → 409（P2002 转 CONFLICT）', async () => {
    await createRecord(bossToken, {
      contentKey: `cr-${tag}-dup`,
      title: `首条${tag}`,
    }).expect(201);
    const dup = await createRecord(managerToken, {
      contentKey: `cr-${tag}-dup`,
      title: `重复条${tag}`,
    }).expect(409);
    expect((dup.body as { code: string }).code).toBe('CONFLICT');
    expect((dup.body as { message: string }).message).toBe('内容编号已存在');
  });

  it('GET 列表按 publishedAt desc，空值排最后', async () => {
    const a = await createRecord(bossToken, {
      contentKey: `cr-${tag}-sort-a`,
      title: `早发布A${tag}`,
      publishedAt: '2026-08-10T00:00:00.000Z',
    }).expect(201);
    const aId = (a.body as ContentRow).id;
    const b = await createRecord(bossToken, {
      contentKey: `cr-${tag}-sort-b`,
      title: `晚发布B${tag}`,
      publishedAt: '2026-08-20T00:00:00.000Z',
    }).expect(201);
    const bId = (b.body as ContentRow).id;
    const c = await createRecord(bossToken, {
      contentKey: `cr-${tag}-sort-c`,
      title: `未登记发布日期C${tag}`,
    }).expect(201);
    const cId = (c.body as ContentRow).id;

    const list = await api()
      .get('/api/v1/marketing/content-records')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    const rows = list.body as ContentRow[];
    const idxA = rows.findIndex((v) => v.id === aId);
    const idxB = rows.findIndex((v) => v.id === bId);
    const idxC = rows.findIndex((v) => v.id === cId);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxC).toBeGreaterThanOrEqual(0);
    // B（08-20）在 A（08-10）之前；C（无 publishedAt）排最后
    expect(idxB).toBeLessThan(idxA);
    expect(idxA).toBeLessThan(idxC);
  });

  it('PATCH 更新互动数据/备注 → 200（归因键与标题不可改）', async () => {
    const created = await createRecord(bossToken, {
      contentKey: `cr-${tag}-patch`,
      title: `待更新互动数据${tag}`,
      costFen: 1000,
      viewsCount: 50,
    }).expect(201);
    baseId = (created.body as ContentRow).id;

    // 互动三项 + 备注 + 成本均可改
    const updated = await api()
      .patch(`/api/v1/marketing/content-records/${baseId}`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({
        viewsCount: 1200,
        likesCount: 88,
        commentsCount: 9,
        costFen: 5200,
        note: `数据回填${tag}`,
      })
      .expect(200);
    const row = updated.body as ContentRow;
    expect(row.viewsCount).toBe(1200);
    expect(row.likesCount).toBe(88);
    expect(row.commentsCount).toBe(9);
    expect(row.costFen).toBe(5200);
    expect(row.note).toBe(`数据回填${tag}`);
    // 归因键与标题保持原值（DTO 不接收，zod 剥离未知字段）
    expect(row.contentKey).toBe(`cr-${tag}-patch`);
    expect(row.title).toBe(`待更新互动数据${tag}`);

    // 店长仅持 m02:approve（无 m02:edit）——写口径 m02:edit ∪ m02:approve，可更新
    await api()
      .patch(`/api/v1/marketing/content-records/${baseId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ viewsCount: 1300 })
      .expect(200);

    // 空请求体 → 400；只带不可改字段（剥离后为空）→ 400
    await api()
      .patch(`/api/v1/marketing/content-records/${baseId}`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({})
      .expect(400);
    await api()
      .patch(`/api/v1/marketing/content-records/${baseId}`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ contentKey: `cr-${tag}-evil`, title: `改标题${tag}` })
      .expect(400);

    // 不存在 id → 404
    await api()
      .patch('/api/v1/marketing/content-records/nonexistent-id')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ viewsCount: 1 })
      .expect(404);
  });

  it('recorder 无 m02 权限 → GET/POST/PATCH 一律 403', async () => {
    await api()
      .get('/api/v1/marketing/content-records')
      .set('Authorization', `Bearer ${recorderToken}`)
      .expect(403);
    await createRecord(recorderToken, {
      contentKey: `cr-${tag}-recorder`,
      title: `记录员越权${tag}`,
    }).expect(403);
    await api()
      .patch(`/api/v1/marketing/content-records/${baseId}`)
      .set('Authorization', `Bearer ${recorderToken}`)
      .send({ viewsCount: 1 })
      .expect(403);

    // 销售持 m02:edit：可写（与既有营销写端点同口径）
    await createRecord(salesToken, {
      contentKey: `cr-${tag}-sales`,
      title: `销售登记${tag}`,
    }).expect(201);
  });

  it('审计行 content_record.created/updated 留痕', async () => {
    const created = await createRecord(bossToken, {
      contentKey: `cr-${tag}-audit`,
      title: `审计留痕${tag}`,
      costFen: 3000,
    }).expect(201);
    const id = (created.body as ContentRow).id;

    const createdAudit = await prisma.auditLog.findFirst({
      where: { objectType: 'content_record', objectId: id, action: 'content_record.created' },
    });
    expect(createdAudit).not.toBeNull();
    expect(createdAudit!.actorId).toBe(bossId);
    expect(createdAudit!.after as object).toMatchObject({
      contentKey: `cr-${tag}-audit`,
      title: `审计留痕${tag}`,
      costFen: 3000,
    });

    await api()
      .patch(`/api/v1/marketing/content-records/${id}`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ viewsCount: 777 })
      .expect(200);
    const updatedAudit = await prisma.auditLog.findFirst({
      where: { objectType: 'content_record', objectId: id, action: 'content_record.updated' },
    });
    expect(updatedAudit).not.toBeNull();
    expect(updatedAudit!.before as object).toMatchObject({ viewsCount: null });
    expect(updatedAudit!.after as object).toMatchObject({ viewsCount: 777 });
  });
});
