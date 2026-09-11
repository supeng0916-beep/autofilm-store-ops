import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { VisitService } from '../src/modules/aftercare/visit.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface VisitRow {
  id: string;
  workOrderId: string;
  customerId: string | null;
  plan: string;
  dueAt: string;
  status: string;
  executedBy: string | null;
  executedAt: string | null;
  note: string | null;
  createdBy: string | null;
}

/** 回访计划集成测试（M09 · 批次1）：列表状态过滤 + 三角色手工 custom 创建 + 执行/跳过留痕与防重 + 到期口径 */
describe('回访计划（M09 · 批次1）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  // 每次运行唯一 tag：测试库数据跨运行残留，note/orderNo 用 tag 隔离（appointment.e2e.spec 同手法）
  const tag = Math.random().toString(36).slice(2, 8);
  const day = 24 * 3600 * 1000;
  let bossToken = '';
  let managerToken = '';
  let salesToken = '';
  let recorderToken = '';
  let managerId = '';
  let salesId = '';
  let workOrderId = '';
  let planWorkOrderId = '';

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

  const createVisit = (token: string, extra: Record<string, unknown>) =>
    api()
      .post('/api/v1/aftercare/visits')
      .set('Authorization', `Bearer ${token}`)
      .send({ workOrderId, ...extra });

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    bossToken = (await mkUser(uniqueUsername('m09_boss'), 'boss')).token;
    const manager = await mkUser(uniqueUsername('m09_manager'), 'store_manager');
    managerToken = manager.token;
    managerId = manager.id;
    const sales = await mkUser(uniqueUsername('m09_sales'), 'sales_ops');
    salesToken = sales.token;
    salesId = sales.id;
    recorderToken = (await mkUser(uniqueUsername('m09_recorder'), 'recorder')).token;
    // 载体：prisma 直建两条 work_order（orderNo 含 tag）——一条给端点用例，一条专供 planForWorkOrder 幂等
    // （端点用例会在载体上建 custom 回访，若共用则 countByWorkOrder>0 干扰幂等首调）
    workOrderId = (
      await prisma.workOrder.create({
        data: {
          orderNo: `W-${tag}-V001`,
          serviceItem: 'DM10 全车隔热膜',
          stage: 'delivered',
          deliveredAt: new Date(),
        },
      })
    ).id;
    planWorkOrderId = (
      await prisma.workOrder.create({
        data: {
          orderNo: `W-${tag}-P001`,
          serviceItem: 'DM13 前挡',
          stage: 'delivered',
          deliveredAt: new Date(),
        },
      })
    ).id;
  });

  afterAll(async () => {
    // 清理口径（brief）：visit 按 note 含 tag 清扫；planForWorkOrder 生成的两条无 note，按载体 workOrderId 兜底
    await prisma.aftercareVisit.deleteMany({ where: { note: { contains: tag } } });
    await prisma.aftercareVisit.deleteMany({
      where: { workOrderId: { in: [workOrderId, planWorkOrderId] } },
    });
    await prisma.workOrder.deleteMany({ where: { orderNo: { contains: tag } } });
    await app.close();
  });

  it('GET 列表按 status 过滤，无权限角色 403', async () => {
    // recorder 无 m09:view → 403
    await api()
      .get('/api/v1/aftercare/visits')
      .set('Authorization', `Bearer ${recorderToken}`)
      .expect(403);
    // boss/店长/销售均有查看权限
    await api()
      .get('/api/v1/aftercare/visits')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    await api()
      .get('/api/v1/aftercare/visits')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    await api()
      .get('/api/v1/aftercare/visits')
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);

    // status 过滤：先建一条再执行，验证三档过滤口径（增量口径：只断言本套件 id 在/不在）
    const created = await createVisit(salesToken, {
      dueAt: new Date(Date.now() + 3 * day).toISOString(),
      note: `列表过滤${tag}`,
    }).expect(201);
    const id = (created.body as VisitRow).id;
    await api()
      .post(`/api/v1/aftercare/visits/${id}/execute`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({})
      .expect(200);

    const done = await api()
      .get('/api/v1/aftercare/visits?status=done')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    expect((done.body as VisitRow[]).some((v) => v.id === id)).toBe(true);
    const pending = await api()
      .get('/api/v1/aftercare/visits?status=pending')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    expect((pending.body as VisitRow[]).some((v) => v.id === id)).toBe(false);
    const skipped = await api()
      .get('/api/v1/aftercare/visits?status=skipped')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    expect((skipped.body as VisitRow[]).some((v) => v.id === id)).toBe(false);
  });

  it('POST 手工创建 custom 回访，boss/店长/销售均可', async () => {
    for (const [token, who] of [
      [bossToken, 'boss'],
      [managerToken, '店长'],
      [salesToken, '销售'],
    ] as Array<[string, string]>) {
      const res = await createVisit(token, {
        dueAt: new Date(Date.now() + 5 * day).toISOString(),
        note: `手工回访-${who}-${tag}`,
      }).expect(201);
      const body = res.body as VisitRow;
      expect(body.id).toBeTruthy();
      expect(body.status).toBe('pending');
      expect(body.plan).toBe('custom');
      expect(body.workOrderId).toBe(workOrderId);
    }
    // recorder 无 m09:edit → 创建同样 403
    await createVisit(recorderToken, {
      dueAt: new Date(Date.now() + day).toISOString(),
      note: `越权创建${tag}`,
    }).expect(403);
  });

  it('execute 后状态 done 且留痕；重复 execute 返回 409', async () => {
    const created = await createVisit(salesToken, {
      dueAt: new Date(Date.now() + 2 * day).toISOString(),
      note: `执行留痕${tag}`,
    }).expect(201);
    const id = (created.body as VisitRow).id;

    const res = await api()
      .post(`/api/v1/aftercare/visits/${id}/execute`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ note: `回访完成，客户满意${tag}` })
      .expect(200);
    expect((res.body as VisitRow).status).toBe('done');

    // 库内留痕：执行人/执行时间/备注
    const row = await prisma.aftercareVisit.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('done');
    expect(row.executedBy).toBe(managerId);
    expect(row.executedAt).toBeTruthy();
    expect(row.note).toBe(`回访完成，客户满意${tag}`);

    // 审计留痕（S11 可追溯）
    const audit = await prisma.auditLog.findFirst({
      where: { objectType: 'aftercare_visit', objectId: id, action: 'visit.executed' },
    });
    expect(audit?.actorId).toBe(managerId);

    // 重复 execute → 409 AFTERCARE_INVALID_STATE
    const dup = await api()
      .post(`/api/v1/aftercare/visits/${id}/execute`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({})
      .expect(409);
    expect((dup.body as { code: string }).code).toBe('AFTERCARE_INVALID_STATE');
    // done 之后也不能再 skip（同一条件更新口径）
    await api()
      .post(`/api/v1/aftercare/visits/${id}/skip`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({})
      .expect(409);
  });

  it('skip 后状态 skipped', async () => {
    const created = await createVisit(salesToken, {
      dueAt: new Date(Date.now() + day).toISOString(),
      note: `跳过用例${tag}`,
    }).expect(201);
    const id = (created.body as VisitRow).id;

    const res = await api()
      .post(`/api/v1/aftercare/visits/${id}/skip`)
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ note: `客户未接通，跳过${tag}` })
      .expect(200);
    expect((res.body as VisitRow).status).toBe('skipped');

    const row = await prisma.aftercareVisit.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('skipped');
    expect(row.executedBy).toBe(salesId);
    expect(row.executedAt).toBeTruthy();
    expect(row.note).toBe(`客户未接通，跳过${tag}`);

    const audit = await prisma.auditLog.findFirst({
      where: { objectType: 'aftercare_visit', objectId: id, action: 'visit.skipped' },
    });
    expect(audit?.actorId).toBe(salesId);

    // 重复 skip → 409
    await api()
      .post(`/api/v1/aftercare/visits/${id}/skip`)
      .set('Authorization', `Bearer ${salesToken}`)
      .send({})
      .expect(409);
  });

  it('dueAt 早于今天的回访出现在列表且可筛出（到期口径）', async () => {
    // 创建允许过去到期日：逾期回访补录场景（列表负责暴露，不拦截创建）
    const overdue = await createVisit(salesToken, {
      dueAt: new Date(Date.now() - 2 * day).toISOString(),
      note: `逾期回访${tag}`,
    }).expect(201);
    const overdueId = (overdue.body as VisitRow).id;
    const future = await createVisit(salesToken, {
      dueAt: new Date(Date.now() + 6 * day).toISOString(),
      note: `未到期回访${tag}`,
    }).expect(201);
    const futureId = (future.body as VisitRow).id;

    // 出现在列表（不带过滤），且逾期者排序在前（dueAt asc）
    const all = await api()
      .get('/api/v1/aftercare/visits')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    const rows = all.body as VisitRow[];
    const iOver = rows.findIndex((v) => v.id === overdueId);
    const iFuture = rows.findIndex((v) => v.id === futureId);
    expect(iOver).toBeGreaterThanOrEqual(0);
    expect(iFuture).toBeGreaterThanOrEqual(0);
    expect(iOver).toBeLessThan(iFuture);

    // 可按 status 筛出：逾期仍属 pending，不出现在 done
    const pending = await api()
      .get('/api/v1/aftercare/visits?status=pending')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    expect((pending.body as VisitRow[]).some((v) => v.id === overdueId)).toBe(true);
    const done = await api()
      .get('/api/v1/aftercare/visits?status=done')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    expect((done.body as VisitRow[]).some((v) => v.id === overdueId)).toBe(false);
  });

  it('planForWorkOrder：首调生成 d7/d30 两条，再调返回 0（交付钩子幂等，Task 5 契约）', async () => {
    const svc = app.get(VisitService);
    const deliveredAt = new Date(Date.now() - 20 * day);

    const n1 = await svc.planForWorkOrder(planWorkOrderId, null, deliveredAt);
    expect(n1).toBe(2);
    const rows = await prisma.aftercareVisit.findMany({ where: { workOrderId: planWorkOrderId } });
    expect(rows).toHaveLength(2);
    const d7 = rows.find((r) => r.plan === 'd7');
    const d30 = rows.find((r) => r.plan === 'd30');
    expect(d7?.status).toBe('pending');
    expect(d30?.status).toBe('pending');
    expect(d7?.dueAt.getTime()).toBe(deliveredAt.getTime() + 7 * day);
    expect(d30?.dueAt.getTime()).toBe(deliveredAt.getTime() + 30 * day);

    // 幂等：已有回访记录（含手工 custom）的工单不重复生成
    const n2 = await svc.planForWorkOrder(planWorkOrderId, null, deliveredAt);
    expect(n2).toBe(0);
    expect(await prisma.aftercareVisit.count({ where: { workOrderId: planWorkOrderId } })).toBe(2);
  });
});
