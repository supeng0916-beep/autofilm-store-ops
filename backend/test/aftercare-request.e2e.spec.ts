import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface SrRow {
  id: string;
  customerId: string | null;
  leadId: string | null;
  workOrderId: string | null;
  kind: string;
  content: string;
  status: string;
  handlerUserId: string | null;
  resolvedAt: string | null;
  result: string | null;
  createdBy: string | null;
}

/** 售后受理集成测试（M09 · 批次1）：四种类受理创建 + 投诉直通老板通知 +
 * 领单/解决单向状态机 + 终态防重与越权拦截 */
describe('售后受理（M09 · 批次1）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  // 每次运行唯一 tag：测试库数据跨运行残留，content 用 tag 隔离（同批次 aftercare-visit 同手法）
  const tag = Math.random().toString(36).slice(2, 8);
  let bossToken = '';
  let bossId = '';
  let managerToken = '';
  let managerId = '';
  let salesToken = '';
  let salesId = '';
  let recorderToken = '';
  let workOrderId = '';

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

  const createSr = (token: string, extra: Record<string, unknown>) =>
    api()
      .post('/api/v1/aftercare/service-requests')
      .set('Authorization', `Bearer ${token}`)
      .send(extra);

  const patchSr = (token: string, id: string, body: Record<string, unknown>) =>
    api()
      .patch(`/api/v1/aftercare/service-requests/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const boss = await mkUser(uniqueUsername('m09sr_boss'), 'boss');
    bossToken = boss.token;
    bossId = boss.id;
    const manager = await mkUser(uniqueUsername('m09sr_manager'), 'store_manager');
    managerToken = manager.token;
    managerId = manager.id;
    const sales = await mkUser(uniqueUsername('m09sr_sales'), 'sales_ops');
    salesToken = sales.token;
    salesId = sales.id;
    recorderToken = (await mkUser(uniqueUsername('m09sr_recorder'), 'recorder')).token;
    // 载体：prisma 直建 work_order（orderNo 含 tag）——受理的 workOrderId 关联可选，此处给真实载体
    workOrderId = (
      await prisma.workOrder.create({
        data: {
          orderNo: `W-${tag}-SR01`,
          serviceItem: 'DM10 全车隔热膜',
          stage: 'delivered',
          deliveredAt: new Date(),
        },
      })
    ).id;
  });

  afterAll(async () => {
    // 清理口径：受理按 content 含 tag 清扫；通知按本套件 boss 收件人 + 投诉 kind 清扫；载体按 orderNo
    await prisma.serviceRequest.deleteMany({ where: { content: { contains: tag } } });
    await prisma.notification.deleteMany({
      where: { userId: bossId, kind: 'service_request.complaint' },
    });
    await prisma.workOrder.deleteMany({ where: { orderNo: { contains: tag } } });
    await app.close();
  });

  it('POST 创建咨询受理 → 201，状态 open', async () => {
    const res = await createSr(salesToken, {
      kind: 'consult',
      content: `客户咨询膜面保养事项${tag}`,
      workOrderId,
    }).expect(201);
    const body = res.body as SrRow;
    expect(body.id).toBeTruthy();
    expect(body.status).toBe('open');
    expect(body.kind).toBe('consult');
    expect(body.workOrderId).toBe(workOrderId);
    expect(body.createdBy).toBe(salesId);
    expect(body.resolvedAt).toBeNull();

    // 审计留痕（S11 可追溯）
    const audit = await prisma.auditLog.findFirst({
      where: {
        objectType: 'service_request',
        objectId: body.id,
        action: 'service_request.created',
      },
    });
    expect(audit?.actorId).toBe(salesId);

    // GET 列表按 kind/status 过滤（增量口径：只断言本套件 id 在/不在）
    const byKind = await api()
      .get('/api/v1/aftercare/service-requests?kind=consult')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    expect((byKind.body as SrRow[]).some((v) => v.id === body.id)).toBe(true);
    const otherKind = await api()
      .get('/api/v1/aftercare/service-requests?kind=complaint')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    expect((otherKind.body as SrRow[]).some((v) => v.id === body.id)).toBe(false);
    const byStatus = await api()
      .get('/api/v1/aftercare/service-requests?status=open')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    expect((byStatus.body as SrRow[]).some((v) => v.id === body.id)).toBe(true);
    const resolvedOnly = await api()
      .get('/api/v1/aftercare/service-requests?status=resolved')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    expect((resolvedOnly.body as SrRow[]).some((v) => v.id === body.id)).toBe(false);
  });

  it('POST 投诉 → 201 且老板收到通知（通知行 kind=service_request.complaint 计数增量 +1）', async () => {
    // 增量口径（HANDOFF 踩坑）：先取基线行数再断言 delta，勿断言绝对行数。
    // 收件人锁定本套件新建的 boss 用户（每次运行唯一），避免共享测试库残留老板账号干扰
    const baseline = await prisma.notification.count({
      where: { userId: bossId, kind: 'service_request.complaint' },
    });

    const content = `投诉：施工后膜面起泡，要求返工处理${tag}`;
    const res = await createSr(salesToken, {
      kind: 'complaint',
      content,
      workOrderId,
    }).expect(201);
    const body = res.body as SrRow;
    expect(body.status).toBe('open');
    expect(body.kind).toBe('complaint');

    const after = await prisma.notification.count({
      where: { userId: bossId, kind: 'service_request.complaint' },
    });
    expect(after).toBe(baseline + 1);

    // 通知载荷：标题/正文前 60 字/跳转链接/业务回指
    const note = await prisma.notification.findFirst({
      where: { userId: bossId, kind: 'service_request.complaint', sourceId: body.id },
    });
    expect(note).not.toBeNull();
    expect(note!.title).toBe('新投诉受理');
    expect(note!.body).toBe(content.slice(0, 60));
    expect(note!.link).toBe('/aftercare');
    expect(note!.sourceType).toBe('service_request');

    // 非投诉受理不触发老板通知：consult/recheck/other 创建后计数不涨
    await createSr(salesToken, { kind: 'recheck', content: `复检预约确认${tag}` }).expect(201);
    expect(
      await prisma.notification.count({
        where: { userId: bossId, kind: 'service_request.complaint' },
      }),
    ).toBe(baseline + 1);
  });

  it('PATCH 领单（status=in_progress+handlerUserId）→ 200；解决（resolved+result）写 resolvedAt', async () => {
    const created = await createSr(managerToken, {
      kind: 'other',
      content: `客户反馈停车地点咨询${tag}`,
    }).expect(201);
    const id = (created.body as SrRow).id;

    // 领单：open → in_progress，记录处理人
    const taken = await patchSr(managerToken, id, {
      status: 'in_progress',
      handlerUserId: managerId,
    }).expect(200);
    expect((taken.body as SrRow).status).toBe('in_progress');
    expect((taken.body as SrRow).handlerUserId).toBe(managerId);

    // 解决：in_progress → resolved，自动写 resolvedAt 与处理结果
    const result = `已电话答复客户，问题解决${tag}`;
    const resolved = await patchSr(managerToken, id, { status: 'resolved', result }).expect(200);
    expect((resolved.body as SrRow).status).toBe('resolved');
    expect((resolved.body as SrRow).result).toBe(result);
    expect((resolved.body as SrRow).resolvedAt).toBeTruthy();

    const row = await prisma.serviceRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('resolved');
    expect(row.handlerUserId).toBe(managerId);
    expect(row.resolvedAt).toBeTruthy();
    expect(row.result).toBe(result);

    // 状态迁移留痕（S11 可追溯）
    const audit = await prisma.auditLog.findFirst({
      where: { objectType: 'service_request', objectId: id, action: 'service_request.updated' },
    });
    expect(audit).not.toBeNull();
  });

  it('resolved 后再 PATCH → 409；recorder 角色 → 403', async () => {
    const created = await createSr(bossToken, {
      kind: 'consult',
      content: `质保查询${tag}`,
    }).expect(201);
    const id = (created.body as SrRow).id;
    await patchSr(bossToken, id, { status: 'in_progress', handlerUserId: bossId }).expect(200);
    await patchSr(bossToken, id, { status: 'resolved', result: `已答复${tag}` }).expect(200);

    // 终态防重：已解决再领单/再解决均 409 AFTERCARE_INVALID_STATE
    const dupTake = await patchSr(bossToken, id, {
      status: 'in_progress',
      handlerUserId: managerId,
    }).expect(409);
    expect((dupTake.body as { code: string }).code).toBe('AFTERCARE_INVALID_STATE');
    const dupResolve = await patchSr(bossToken, id, {
      status: 'resolved',
      result: '再次解决',
    }).expect(409);
    expect((dupResolve.body as { code: string }).code).toBe('AFTERCARE_INVALID_STATE');

    // recorder 无 m09:view/m09:edit → 列表/创建/更新一律 403
    await api()
      .get('/api/v1/aftercare/service-requests')
      .set('Authorization', `Bearer ${recorderToken}`)
      .expect(403);
    await createSr(recorderToken, { kind: 'other', content: `越权创建${tag}` }).expect(403);
    await patchSr(recorderToken, id, { status: 'in_progress' }).expect(403);
  });
});
