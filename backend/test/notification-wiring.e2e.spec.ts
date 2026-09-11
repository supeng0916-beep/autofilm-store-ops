import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface ApprovalRow {
  id: string;
  type: string;
  status: string;
  payload: { appointmentId?: string };
}
interface AppointmentCreated {
  appointment: { id: string; status: string };
}
interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  sourceType: string | null;
  sourceId: string | null;
}

/** 通知接线集成测试（V2.2a Task4）：走真实 API 验证审批/排期关键节点落通知。
 * 接线为尽力而为（void 不 await）：通知写入可能在响应返回后才落库，断言统一 vi.waitFor 轮询。
 * 隔离：工位带随机 tag；通知断言限定 userId+sourceId（本运行创建的业务对象 id），不受历史数据干扰。 */
describe('通知接线：审批与排期（V2.2a）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  const tag = Math.random().toString(36).slice(2, 8);
  let bossId = '';
  let managerToken = '';
  let managerId = '';
  let salesToken = '';
  let salesId = '';

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
    // 登录为创建动作（POST /auth/login → 201），非查询语义
    expect(res.status).toBe(201);
    return { token: (res.body as { accessToken: string }).accessToken, id: user.id };
  };

  /** 指定小时起的 2 小时时段（基准=当前+30 天：后端 2026-08-28 起拒绝过去时间，
   * 固定日期会随日历推进过期被 400 拒绝） */
  const slotBase = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  const slot = (startHour: number) => ({
    startAt: new Date(
      Date.UTC(slotBase.getUTCFullYear(), slotBase.getUTCMonth(), slotBase.getUTCDate(), startHour),
    ).toISOString(),
    endAt: new Date(
      Date.UTC(
        slotBase.getUTCFullYear(),
        slotBase.getUTCMonth(),
        slotBase.getUTCDate(),
        startHour + 2,
      ),
    ).toISOString(),
  });

  /** 等待尽力而为的异步通知落库并返回该条 */
  const waitNotification = async (where: Record<string, unknown>): Promise<NotificationRow> => {
    let found: NotificationRow | null = null;
    await vi.waitFor(
      async () => {
        found = await prisma.notification.findFirst({ where, orderBy: { createdAt: 'desc' } });
        expect(found).not.toBeNull();
      },
      { timeout: 3000, interval: 50 },
    );
    return found!;
  };

  /** 待审排期审批项（按预约 id 定位，tag 隔离） */
  const findScheduleApproval = async (appointmentId: string): Promise<ApprovalRow> => {
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/approvals?status=pending')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    const item = (res.body as ApprovalRow[]).find(
      (a) => a.type === 'm07.schedule.confirm' && a.payload.appointmentId === appointmentId,
    );
    expect(item).toBeDefined();
    return item!;
  };

  const createAppt = (workbench: string, startHour: number) =>
    request(app.getHttpServer() as Server)
      .post('/api/v1/appointments')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({
        customerId: 'cust_v22a_tag',
        serviceItem: 'DM10 全车隔热膜',
        businessType: 'window_film',
        workbench,
        ...slot(startHour),
      });

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const boss = await mkUser(uniqueUsername('nwf_boss'), 'boss');
    bossId = boss.id;
    const manager = await mkUser(uniqueUsername('nwf_mgr'), 'store_manager');
    managerToken = manager.token;
    managerId = manager.id;
    const sales = await mkUser(uniqueUsername('nwf_sales'), 'sales_ops');
    salesToken = sales.token;
    salesId = sales.id;
  });

  afterAll(async () => {
    // 只清本 spec 维度：三人通知 + tag 工位预约（测试库有历史数据，禁全库清）
    await prisma.notification.deleteMany({
      where: { userId: { in: [bossId, managerId, salesId] } },
    });
    await prisma.appointment.deleteMany({ where: { workbench: { contains: tag } } });
    await app.close();
  });

  it('审批创建：boss 与 store_manager 收到 approval_pending（链接审批中心）', async () => {
    const created = await request(app.getHttpServer() as Server)
      .post('/api/v1/approvals')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ type: 'generic', payload: { tag }, basis: '通知接线验证' })
      .expect(201);
    const approvalId = (created.body as ApprovalRow).id;

    const bossNtf = await waitNotification({
      userId: bossId,
      kind: 'approval_pending',
      sourceType: 'approval',
      sourceId: approvalId,
    });
    expect(bossNtf.link).toBe('/approvals');

    // 同一次群发：store_manager 也收到同源通知
    const mgrNtf = await prisma.notification.findFirst({
      where: { userId: managerId, kind: 'approval_pending', sourceId: approvalId },
    });
    expect(mgrNtf).not.toBeNull();
  });

  it('排期链路：销售建预约→店长批准→销售收 appointment_confirmed 与 approval_decided', async () => {
    const created = await createAppt(`${tag}W1`, 2).expect(201);
    const apptId = (created.body as AppointmentCreated).appointment.id;

    // 预约自动发起排期审批（P5-03）：审批创建同样落 approval_pending 给 boss
    const item = await findScheduleApproval(apptId);
    await waitNotification({
      userId: bossId,
      kind: 'approval_pending',
      sourceType: 'approval',
      sourceId: item.id,
    });

    await request(app.getHttpServer() as Server)
      .post(`/api/v1/approvals/${item.id}/approve`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ confirmed: true, opinion: '排期无冲突' })
      .expect(201);

    // 排期确认回调通知发起人（appointment.createdBy）
    const confirmed = await waitNotification({
      userId: salesId,
      kind: 'appointment_confirmed',
      sourceType: 'appointment',
      sourceId: apptId,
    });
    expect(confirmed.link).toBe('/appointments');

    // 审批结果通知发起人（requesterId），批准文案
    const decided = await waitNotification({
      userId: salesId,
      kind: 'approval_decided',
      sourceType: 'approval',
      sourceId: item.id,
    });
    expect(decided.title).toContain('通过');
  });

  it('排期驳回：发起人收 approval_decided（驳回），不产生 appointment_confirmed', async () => {
    const created = await createAppt(`${tag}W2`, 6).expect(201);
    const apptId = (created.body as AppointmentCreated).appointment.id;
    const item = await findScheduleApproval(apptId);

    await request(app.getHttpServer() as Server)
      .post(`/api/v1/approvals/${item.id}/reject`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ confirmed: true, reason: '当日工位检修，改期再提' })
      .expect(201);

    const decided = await waitNotification({
      userId: salesId,
      kind: 'approval_decided',
      sourceType: 'approval',
      sourceId: item.id,
    });
    expect(decided.title).toContain('驳回');

    // 驳回不触发排期确认回调：该预约无 confirmed 通知
    const none = await prisma.notification.findFirst({
      where: { userId: salesId, kind: 'appointment_confirmed', sourceId: apptId },
    });
    expect(none).toBeNull();
  });
});
