import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface WrRow {
  id: string;
  workOrderId: string | null;
  customerId: string | null;
  productModel: string | null;
  registrationNo: string | null;
  registeredAt: string | null;
  status: string;
  note: string | null;
  createdBy: string | null;
}

interface RfRow {
  id: string;
  referrerCustomerId: string;
  referredLeadId: string | null;
  referredCustomerId: string | null;
  status: string;
  note: string | null;
  createdBy: string | null;
}

/** 质保登记与转介绍集成测试（M09 · 批次1）：质保创建→登记（register）→重复 409；
 * 转介绍创建→同客资唯一约束 409→mark-won→重复 409 */
describe('质保登记与转介绍（M09 · 批次1）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  // 每次运行唯一 tag：测试库数据跨运行残留，note/leadNo/name/orderNo 用 tag 隔离（同批次既有套件同手法）
  const tag = Math.random().toString(36).slice(2, 8);
  let bossToken = '';
  let managerToken = '';
  let salesToken = '';
  let salesId = '';
  let recorderToken = '';
  let workOrderId = '';
  let customerId = '';
  let referrerCustomerId = '';
  let referredLeadId = '';

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

  const createWr = (token: string, extra: Record<string, unknown>) =>
    api()
      .post('/api/v1/aftercare/warranty-registrations')
      .set('Authorization', `Bearer ${token}`)
      .send(extra);

  const registerWr = (token: string, id: string, body: Record<string, unknown> = {}) =>
    api()
      .post(`/api/v1/aftercare/warranty-registrations/${id}/register`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const createRf = (token: string, extra: Record<string, unknown>) =>
    api().post('/api/v1/aftercare/referrals').set('Authorization', `Bearer ${token}`).send(extra);

  const markWon = (token: string, id: string) =>
    api()
      .post(`/api/v1/aftercare/referrals/${id}/mark-won`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    bossToken = (await mkUser(uniqueUsername('m09wr_boss'), 'boss')).token;
    managerToken = (await mkUser(uniqueUsername('m09wr_manager'), 'store_manager')).token;
    const sales = await mkUser(uniqueUsername('m09wr_sales'), 'sales_ops');
    salesToken = sales.token;
    salesId = sales.id;
    recorderToken = (await mkUser(uniqueUsername('m09wr_recorder'), 'recorder')).token;
    // 载体：prisma 直建 work_order 与两份客户档案、一条被转介绍客资（均含 tag）
    workOrderId = (
      await prisma.workOrder.create({
        data: {
          orderNo: `W-${tag}-WR01`,
          serviceItem: 'DM10 全车隔热膜',
          stage: 'delivered',
          deliveredAt: new Date(),
        },
      })
    ).id;
    customerId = (
      await prisma.customer.create({
        data: { name: `质保客户${tag}`, phone: `138${tag}00`.slice(0, 11) },
      })
    ).id;
    referrerCustomerId = (
      await prisma.customer.create({
        data: { name: `介绍人${tag}`, phone: `139${tag}00`.slice(0, 11) },
      })
    ).id;
    referredLeadId = (
      await prisma.lead.create({
        data: {
          leadNo: `L-${tag}-RF01`,
          sourceCategory: 'offline',
          sourcePlatform: '老客户转介绍',
          customerName: `被转介绍客${tag}`,
        },
      })
    ).id;
  });

  afterAll(async () => {
    // 清理口径：质保按载体 workOrderId 清扫；转介绍按本套件介绍人清扫；客资/客户/工单按 tag
    await prisma.warrantyRegistration.deleteMany({ where: { workOrderId } });
    await prisma.referralRecord.deleteMany({ where: { referrerCustomerId } });
    await prisma.lead.deleteMany({ where: { leadNo: { contains: tag } } });
    await prisma.customer.deleteMany({ where: { name: { contains: tag } } });
    await prisma.workOrder.deleteMany({ where: { orderNo: { contains: tag } } });
    await app.close();
  });

  it('POST 质保登记创建 → 201，状态 pending；列表可筛', async () => {
    const registeredAt = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    const res = await createWr(salesToken, {
      workOrderId,
      customerId,
      productModel: 'DM10',
      registrationNo: `WG-${tag}-001`,
      registeredAt,
      note: `质保登记${tag}`,
    }).expect(201);
    const body = res.body as WrRow;
    expect(body.id).toBeTruthy();
    expect(body.status).toBe('pending');
    expect(body.workOrderId).toBe(workOrderId);
    expect(body.customerId).toBe(customerId);
    expect(body.registrationNo).toBe(`WG-${tag}-001`);
    expect(body.registeredAt).toBe(registeredAt);
    expect(body.createdBy).toBe(salesId);

    // 审计留痕（S11 可追溯）
    const audit = await prisma.auditLog.findFirst({
      where: {
        objectType: 'warranty_registration',
        objectId: body.id,
        action: 'warranty.created',
      },
    });
    expect(audit?.actorId).toBe(salesId);

    // GET 列表按 status 过滤（增量口径：只断言本套件 id 在/不在）
    const pending = await api()
      .get('/api/v1/aftercare/warranty-registrations?status=pending')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    expect((pending.body as WrRow[]).some((v) => v.id === body.id)).toBe(true);
    const registered = await api()
      .get('/api/v1/aftercare/warranty-registrations?status=registered')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    expect((registered.body as WrRow[]).some((v) => v.id === body.id)).toBe(false);

    // recorder 无 m09 权限 → 列表/创建 403
    await api()
      .get('/api/v1/aftercare/warranty-registrations')
      .set('Authorization', `Bearer ${recorderToken}`)
      .expect(403);
    await createWr(recorderToken, { workOrderId, note: `越权创建${tag}` }).expect(403);
  });

  it('register 动作置 registered + registeredAt；重复 register → 409', async () => {
    const created = await createWr(managerToken, {
      workOrderId,
      productModel: 'DM13',
      note: `待登记质保${tag}`,
    }).expect(201);
    const id = (created.body as WrRow).id;
    expect((created.body as WrRow).status).toBe('pending');
    expect((created.body as WrRow).registeredAt).toBeNull();

    const res = await registerWr(managerToken, id).expect(200);
    expect((res.body as WrRow).status).toBe('registered');
    expect((res.body as WrRow).registeredAt).toBeTruthy();

    const row = await prisma.warrantyRegistration.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('registered');
    expect(row.registeredAt).toBeTruthy();

    // 登记动作留痕（S11 可追溯）
    const audit = await prisma.auditLog.findFirst({
      where: { objectType: 'warranty_registration', objectId: id, action: 'warranty.registered' },
    });
    expect(audit?.actorId).toBeTruthy();

    // 终态防重：已登记再 register → 409 AFTERCARE_INVALID_STATE
    const dup = await registerWr(managerToken, id).expect(409);
    expect((dup.body as { code: string }).code).toBe('AFTERCARE_INVALID_STATE');
    // recorder 同样无权执行登记动作
    await registerWr(recorderToken, id).expect(403);
  });

  it('POST 转介绍创建 → 201；同一 referredLeadId 第二次 → 409', async () => {
    const res = await createRf(salesToken, {
      referrerCustomerId,
      referredLeadId,
      note: `老客户转介绍${tag}`,
    }).expect(201);
    const body = res.body as RfRow;
    expect(body.id).toBeTruthy();
    expect(body.status).toBe('pending');
    expect(body.referrerCustomerId).toBe(referrerCustomerId);
    expect(body.referredLeadId).toBe(referredLeadId);
    expect(body.createdBy).toBe(salesId);

    const audit = await prisma.auditLog.findFirst({
      where: { objectType: 'referral_record', objectId: body.id, action: 'referral.created' },
    });
    expect(audit?.actorId).toBe(salesId);

    // 列表可筛（增量口径）
    const all = await api()
      .get('/api/v1/aftercare/referrals')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    expect((all.body as RfRow[]).some((v) => v.id === body.id)).toBe(true);
    const won = await api()
      .get('/api/v1/aftercare/referrals?status=won')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    expect((won.body as RfRow[]).some((v) => v.id === body.id)).toBe(false);

    // 唯一约束：同一客资第二次转介绍登记 → 409（Prisma P2002 转 AFTERCARE_INVALID_STATE）
    const dup = await createRf(managerToken, {
      referrerCustomerId,
      referredLeadId,
      note: `重复登记${tag}`,
    }).expect(409);
    expect((dup.body as { code: string }).code).toBe('AFTERCARE_INVALID_STATE');
    expect((dup.body as { message: string }).message).toBe('该客资已有转介绍登记');

    // DTO 校验：referredLeadId/referredCustomerId 至少一项，缺客体拒绝（refine 失败 → 400）
    const invalid = await createRf(salesToken, {
      referrerCustomerId,
      note: `缺客体${tag}`,
    }).expect(400);
    expect((invalid.body as { code: string }).code).toBe('VALIDATION_FAILED');
    // recorder 无 m09 权限 → 403
    await createRf(recorderToken, { referrerCustomerId, referredLeadId }).expect(403);
  });

  it('mark-won 置 won；重复 mark-won → 409', async () => {
    // 另一条转介绍：仅 referredCustomerId（成交客户路径，不带客资）
    const created = await createRf(bossToken, {
      referrerCustomerId,
      referredCustomerId: customerId,
      note: `成交转介绍${tag}`,
    }).expect(201);
    const id = (created.body as RfRow).id;
    expect((created.body as RfRow).status).toBe('pending');

    const res = await markWon(bossToken, id).expect(200);
    expect((res.body as RfRow).status).toBe('won');

    const row = await prisma.referralRecord.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('won');

    const audit = await prisma.auditLog.findFirst({
      where: { objectType: 'referral_record', objectId: id, action: 'referral.marked_won' },
    });
    expect(audit?.actorId).toBeTruthy();

    // 终态防重：已成交再 mark-won → 409
    const dup = await markWon(bossToken, id).expect(409);
    expect((dup.body as { code: string }).code).toBe('AFTERCARE_INVALID_STATE');
    await markWon(recorderToken, id).expect(403);
  });
});
