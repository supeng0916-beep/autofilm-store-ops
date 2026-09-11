import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface CreatedAppointment {
  appointment: {
    id: string;
    status: string;
    managerConfirmed: boolean;
    technicianName: string | null;
    leadId: string | null;
    customerId: string;
  };
  hints: { estHours: unknown[]; technician: unknown[] };
}

interface ErrorBody {
  code: string;
  detail?: { conflicts?: Array<{ id: string }> };
}

/** 预约模块集成测试（P5-01/02/03）：档期冲突检测 + 指定技师替换确认 + 排期审批 */
describe('预约模块（M07 · P5-01~03）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  // 每次运行唯一 tag：测试库数据跨运行残留，固定工位/技师名会自我冲突
  const tag = Math.random().toString(36).slice(2, 8);
  let managerToken = '';
  let salesToken = '';
  let recorderToken = '';
  let bossToken = '';
  let managerId = '';

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

  /** 时段工厂（基准=当前+30 天的 02:00Z 起）：2026-08-28 起后端拒绝过去时间，
   * 固定日期会随日历推进过期成「过去时间」被 400 拒绝，改相对基准保持长期可跑 */
  const slotBase = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  const slot = (startHour: number, hours: number) => ({
    startAt: new Date(
      Date.UTC(slotBase.getUTCFullYear(), slotBase.getUTCMonth(), slotBase.getUTCDate(), startHour),
    ).toISOString(),
    endAt: new Date(
      Date.UTC(
        slotBase.getUTCFullYear(),
        slotBase.getUTCMonth(),
        slotBase.getUTCDate(),
        startHour + hours,
      ),
    ).toISOString(),
  });

  const createAppt = (token: string, extra: Record<string, unknown>) =>
    request(app.getHttpServer() as Server)
      .post('/api/v1/appointments')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId: 'cust_p5_test', serviceItem: 'DM10 全车隔热膜', ...extra });

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    // 同日重跑残留防御（2026-09-01 V1.5 批次4 加入）：appointment/p6-replay/p6-security/
    // work-order 多套件共用固定技师名+相对基准日造预约，afterAll 清理不完整时同日第二轮
    // 全量互相 409。测试库这三表只有测试数据，全清彻底且安全。
    await prisma.workOrder.deleteMany({});
    await prisma.appointmentTechnicianChange.deleteMany({});
    await prisma.appointment.deleteMany({});
    auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const manager = await mkUser(uniqueUsername('p5_manager'), 'store_manager');
    managerToken = manager.token;
    managerId = manager.id;
    salesToken = (await mkUser(uniqueUsername('p5_sales'), 'sales_ops')).token;
    recorderToken = (await mkUser(uniqueUsername('p5_recorder'), 'recorder')).token;
    bossToken = (await mkUser(uniqueUsername('p5_boss'), 'boss')).token;
  });

  afterAll(async () => {
    // 工位归一化（2026-08-28 UI 测试 #5）后落库值为大写，清理按大写口径
    await prisma.appointment.deleteMany({ where: { workbench: { contains: tag.toUpperCase() } } });
    await app.close();
  });

  it('P5-01 销售 creation：落 pending + 知识提示结构 + 自动发起排期审批', async () => {
    const { startAt, endAt } = slot(2, 3);
    const res = await createAppt(salesToken, {
      businessType: 'car_cover',
      workbench: `${tag}A1`,
      technicianName: '演示技师 B',
      technicianDesignated: true,
      startAt,
      endAt,
    }).expect(201);
    const body = res.body as CreatedAppointment;
    expect(body.appointment.status).toBe('pending');
    expect(body.appointment.managerConfirmed).toBe(false);
    expect(Array.isArray(body.hints.estHours)).toBe(true);
    expect(Array.isArray(body.hints.technician)).toBe(true);

    const approvals = await request(app.getHttpServer() as Server)
      .get('/api/v1/approvals?status=pending')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    const mine = (
      approvals.body as Array<{ type: string; payload: { appointmentId?: string } }>
    ).find(
      (a) => a.type === 'm07.schedule.confirm' && a.payload.appointmentId === body.appointment.id,
    );
    expect(mine).toBeDefined();
  });

  it('2026-08-25 leadId 直建：自动查找/建客户档案并回写 lead.customerId（老板反馈客户ID没人会填）', async () => {
    // 造一条带联系方式、尚无客户档案的客资
    const lead = await prisma.lead.create({
      data: {
        leadNo: `L-APPT-${tag}-0001`,
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        customerName: `预约客${tag}`,
        // 字符映射确定性唯一电话（lead-manual.spec 同手法；纯字母 tag 的旧写法会退化成同一号码撞历史数据）
        phone: `139${tag
          .split('')
          .map((c) => String(c.charCodeAt(0) % 10))
          .join('')
          .padEnd(8, '0')}`,
        productNeed: '车衣',
        receivedAt: new Date(),
      },
    });
    expect(lead.customerId).toBeNull();

    const { startAt, endAt } = slot(4, 2);
    const res = await createAppt(salesToken, {
      customerId: undefined,
      leadId: lead.id,
      businessType: 'car_cover',
      workbench: `LEADLINK-${Date.now().toString(36)}`, // 独立工位名：不含本套件 tag（contains 计数口径）且跨轮唯一
      startAt,
      endAt,
    }).expect(201);
    const body = res.body as CreatedAppointment;
    expect(body.appointment.leadId).toBe(lead.id);
    expect(body.appointment.customerId).toBeTruthy();

    // 客户档案已建并回写客资
    const fresh = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(fresh.customerId).toBe(body.appointment.customerId);
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: fresh.customerId! },
    });
    expect(customer.name).toContain(tag);

    // 清理本用例预约（工位名不含 tag，afterAll 的 tag 清扫覆盖不到，防跨轮残留 409）
    await prisma.appointment.deleteMany({ where: { id: body.appointment.id } });

    // 二选一校验：leadId/customerId 全无 → 拒绝
    const invalid = await request(app.getHttpServer() as Server)
      .post('/api/v1/appointments')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({
        serviceItem: 'DM10 全车隔热膜',
        businessType: 'window_film',
        startAt,
        endAt,
      });
    expect([400, 422]).toContain(invalid.status);
  });

  it('P5-01 同工位同时段重复预约被拦截（409 + 冲突详情）', async () => {
    const { startAt, endAt } = slot(2, 3);
    const res = await createAppt(salesToken, {
      businessType: 'car_cover',
      workbench: `${tag}A1`,
      startAt,
      endAt,
    }).expect(409);
    const body = res.body as ErrorBody;
    expect(body.code).toBe('APPOINTMENT_CONFLICT');
    expect(body.detail?.conflicts?.length).toBeGreaterThan(0);
  });

  it('P5-01 同技师不同工位同时段被拦截；不同技师不同工位可约；相邻时段不冲突', async () => {
    const { startAt, endAt } = slot(2, 3);
    // 同技师（演示技师 B）另一工位 → 冲突
    await createAppt(salesToken, {
      businessType: 'car_cover',
      workbench: `${tag}B2`,
      technicianName: '演示技师 B',
      startAt,
      endAt,
    }).expect(409);
    // 不同技师不同工位 → 成功
    await createAppt(salesToken, {
      businessType: 'car_cover',
      workbench: `${tag}B2`,
      technicianName: '演示技师 C',
      ...slot(2, 2),
    }).expect(201);
    // A1 工位相邻时段（05:00 起，上一段 02:00–05:00 结束）→ 不冲突
    await createAppt(salesToken, {
      businessType: 'car_cover',
      workbench: `${tag}A1`,
      ...slot(5, 2),
    }).expect(201);
  });

  it('P5-01 冲突预检：提醒可见，不产生预约', async () => {
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/appointments/conflict-check')
      .query({ workbench: `${tag}A1`, ...slot(3, 1) })
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    const body = res.body as { conflicts: unknown[] };
    expect(body.conflicts.length).toBeGreaterThan(0);
    // 预检不落库：本次运行已建 3 条（test1 一条 + test3 两条）
    const total = await prisma.appointment.count({
      where: { workbench: { contains: tag.toUpperCase() } },
    });
    expect(total).toBe(3);
  });

  it('P5-01 越权：recorder 不可见（403）；老板可发起（2026-08-19 矩阵变更）', async () => {
    await request(app.getHttpServer() as Server)
      .get('/api/v1/appointments')
      .set('Authorization', `Bearer ${recorderToken}`)
      .expect(403);
    await createAppt(bossToken, {
      businessType: 'car_cover',
      workbench: `${tag}C9`,
      ...slot(24, 2),
    }).expect(201);
  });

  it('2026-08-28 bug1：已确认排期销售取消 403，店长可取消', async () => {
    const created = await createAppt(salesToken, {
      businessType: 'car_cover',
      workbench: `${tag}C9`,
      ...slot(10, 1),
    }).expect(201);
    const id = (created.body as CreatedAppointment).appointment.id;
    // 直接库内确认（绕过审批回调，聚焦取消权限本身）
    await prisma.appointment.update({
      where: { id },
      data: { managerConfirmed: true, status: 'confirmed' },
    });
    const denied = await request(app.getHttpServer() as Server)
      .post(`/api/v1/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(403);
    expect((denied.body as { message?: string }).message).toContain('店长或老板');
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
  });

  it('P5-01 取消后档期释放，重复取消 409', async () => {
    const created = await createAppt(salesToken, {
      businessType: 'car_cover',
      workbench: `${tag}C3`,
      ...slot(8, 2),
    }).expect(201);
    const id = (created.body as CreatedAppointment).appointment.id;
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    // 档期已释放：同时段同工位可再约
    await createAppt(salesToken, {
      businessType: 'car_cover',
      workbench: `${tag}C3`,
      ...slot(8, 2),
    }).expect(201);
    // 重复取消
    const res = await request(app.getHttpServer() as Server)
      .post(`/api/v1/appointments/${id}/cancel`)
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(409);
    expect((res.body as ErrorBody).code).toBe('APPOINTMENT_INVALID_STATE');
  });

  it('P5-02 指定技师替换：未确认不生效，客户确认后生效且留痕', async () => {
    const created = await createAppt(salesToken, {
      businessType: 'car_cover',
      workbench: `${tag}D4`,
      technicianName: '演示技师 B',
      technicianDesignated: true,
      ...slot(12, 2),
    }).expect(201);
    const id = (created.body as CreatedAppointment).appointment.id;

    const changeRes = await request(app.getHttpServer() as Server)
      .post(`/api/v1/appointments/${id}/technician-change`)
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ toName: '演示技师 C', reason: '演示技师 B请假' })
      .expect(201);
    const changeId = (changeRes.body as { id: string }).id;

    // 未确认：预约技师不变
    const before = await request(app.getHttpServer() as Server)
      .get(`/api/v1/appointments/${id}`)
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    expect((before.body as { technicianName: string }).technicianName).toBe('演示技师 B');

    // 客户确认（微信）→ 生效
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/appointments/${id}/technician-change/${changeId}/confirm`)
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ confirmMethod: 'wechat', note: '客户微信同意' })
      .expect(200);

    const after = await request(app.getHttpServer() as Server)
      .get(`/api/v1/appointments/${id}`)
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    expect((after.body as { technicianName: string }).technicianName).toBe('演示技师 C');

    // 替换记录留痕：确认方式 + 确认时间 + 原因保留
    const changes = await request(app.getHttpServer() as Server)
      .get(`/api/v1/appointments/${id}/technician-changes`)
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    const record = (
      changes.body as Array<{
        id: string;
        status: string;
        confirmMethod: string;
        confirmedAt: string;
        reason: string;
      }>
    ).find((c) => c.id === changeId);
    expect(record?.status).toBe('confirmed');
    expect(record?.confirmMethod).toBe('wechat');
    expect(record?.confirmedAt).toBeTruthy();
    expect(record?.reason).toBe('演示技师 B请假');

    // 重复确认 → 409
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/appointments/${id}/technician-change/${changeId}/confirm`)
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ confirmMethod: 'phone' })
      .expect(409);
  });

  it('P5-03 排期审批：店长 approve 后 managerConfirmed 生效并留确认人/时间', async () => {
    const created = await createAppt(salesToken, {
      businessType: 'car_cover',
      workbench: `${tag}E5`,
      ...slot(16, 2),
    }).expect(201);
    const id = (created.body as CreatedAppointment).appointment.id;

    const approvals = await request(app.getHttpServer() as Server)
      .get('/api/v1/approvals?status=pending')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    const item = (
      approvals.body as Array<{ id: string; type: string; payload: { appointmentId?: string } }>
    ).find((a) => a.type === 'm07.schedule.confirm' && a.payload.appointmentId === id);
    expect(item).toBeDefined();

    await request(app.getHttpServer() as Server)
      .post(`/api/v1/approvals/${item!.id}/approve`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ confirmed: true, opinion: '排期无冲突' })
      .expect(201);

    const res = await request(app.getHttpServer() as Server)
      .get(`/api/v1/appointments/${id}`)
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    const appt = res.body as {
      status: string;
      managerConfirmed: boolean;
      managerConfirmedBy: string | null;
      managerConfirmedAt: string | null;
    };
    expect(appt.managerConfirmed).toBe(true);
    expect(appt.status).toBe('confirmed');
    expect(appt.managerConfirmedBy).toBe(managerId);
    expect(appt.managerConfirmedAt).toBeTruthy();

    // 确认留痕审计（S11：确认人/时间可追溯）
    const audit = await prisma.auditLog.findFirst({
      where: { objectType: 'appointment', objectId: id, action: 'appointment.confirmed' },
    });
    expect(audit?.actorId).toBe(managerId);
  });

  it('2026-08-28 UI 测试 #3 审批驳回：预约联动取消并释放档期（不再永久悬空 pending）', async () => {
    const created = await createAppt(salesToken, {
      businessType: 'car_cover',
      workbench: `${tag}F6`,
      ...slot(20, 2),
    }).expect(201);
    const id = (created.body as CreatedAppointment).appointment.id;
    const approvals = await request(app.getHttpServer() as Server)
      .get('/api/v1/approvals?status=pending')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    const item = (
      approvals.body as Array<{ id: string; type: string; payload: { appointmentId?: string } }>
    ).find((a) => a.type === 'm07.schedule.confirm' && a.payload.appointmentId === id);

    await request(app.getHttpServer() as Server)
      .post(`/api/v1/approvals/${item!.id}/reject`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ confirmed: true, reason: '当日工位检修，改期再提' })
      .expect(201);

    const res = await request(app.getHttpServer() as Server)
      .get(`/api/v1/appointments/${id}`)
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    const appt = res.body as { status: string; managerConfirmed: boolean };
    expect(appt.managerConfirmed).toBe(false);
    // 2026-08-28 UI 测试 #3：此前驳回后预约永久悬空 pending（审批中心不再显示、无人能批
    // 也无法自动取消）；现驳回即取消，档期释放、审计留痕、发起人收通知
    expect(appt.status).toBe('cancelled');
    const audit = await prisma.auditLog.findFirst({
      where: { objectType: 'appointment', objectId: id, action: 'appointment.cancelled' },
    });
    expect(audit?.actorId).toBe(managerId);

    // 档期已释放：同工位同时段可重新预约（销售调整后重提路径）
    await createAppt(salesToken, {
      businessType: 'car_cover',
      workbench: `${tag}F6`,
      ...slot(20, 2),
    }).expect(201);
  });

  it('2026-08-28 UI 测试 #4 过去时间创建预约被拒（400 + 中文提示）', async () => {
    const past = {
      startAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      endAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    const res = await createAppt(salesToken, {
      businessType: 'car_cover',
      workbench: `${tag}PAST`,
      ...past,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('开始时间不能早于当前时间');
  });

  it('2026-08-28 UI 测试 #5 工位写法漂移不再绕过冲突检测（归一化后同位拦截）', async () => {
    const { startAt, endAt } = slot(30, 2);
    // 先建存量工位（落库归一化为大写 TAGG1）
    await createAppt(salesToken, {
      businessType: 'car_cover',
      workbench: `${tag}G1`,
      startAt,
      endAt,
    }).expect(201);
    // 提交「 工位tagg1 」（前缀+小写+空白）→ 归一化后同位 → 409（此前写法漂移曾放行双排期）
    const res = await createAppt(salesToken, {
      businessType: 'car_cover',
      workbench: ` 工位${tag}g1 `,
      startAt,
      endAt,
    });
    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).code).toBe('APPOINTMENT_CONFLICT');
  });

  it('2026-08-28 UI 测试 #2 无技师预约可初次指定（客户确认后生效）', async () => {
    const created = await createAppt(salesToken, {
      businessType: 'car_cover',
      workbench: `${tag}INIT`,
      ...slot(33, 2),
    }).expect(201);
    const id = (created.body as CreatedAppointment).appointment.id;
    expect((created.body as CreatedAppointment).appointment.technicianName).toBeNull();

    // 初次指定：此前该路径被「预约未指定技师，无需替换」拒绝，无处可补
    const changeRes = await request(app.getHttpServer() as Server)
      .post(`/api/v1/appointments/${id}/technician-change`)
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ toName: '演示技师 C', reason: '客户到店前先安排好师傅' })
      .expect(201);
    const changeId = (changeRes.body as { id: string; fromName: string }).id;
    expect((changeRes.body as { fromName: string }).fromName).toBe('（初次指定）');

    await request(app.getHttpServer() as Server)
      .post(`/api/v1/appointments/${id}/technician-change/${changeId}/confirm`)
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ confirmMethod: 'wechat' })
      .expect(200);
    const after = await request(app.getHttpServer() as Server)
      .get(`/api/v1/appointments/${id}`)
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    expect((after.body as { technicianName: string }).technicianName).toBe('演示技师 C');
  });

  it('窗膜单派车衣技师被拒（TECHNICIAN_SKILL_MISMATCH 422）', async () => {
    const res = await createAppt(managerToken, {
      businessType: 'window_film',
      technicianName: '演示技师 B',
      ...slot(2, 2),
    });
    expect(res.status).toBe(422);
    expect((res.body as ErrorBody).code).toBe('TECHNICIAN_SKILL_MISMATCH');
  });

  it('窗膜单派演示技师 A通过', async () => {
    const res = await createAppt(managerToken, {
      businessType: 'window_film',
      technicianName: '演示技师 A',
      workbench: `wb-${tag}-a`,
      ...slot(2, 2),
    });
    expect(res.status).toBe(201);
  });

  it('演示技师 C跨技能池同时段互斥（APPOINTMENT_CONFLICT）', async () => {
    const a = await createAppt(managerToken, {
      businessType: 'car_cover',
      technicianName: '演示技师 C',
      workbench: `wb-${tag}-b`,
      ...slot(6, 4),
    });
    expect(a.status).toBe(201);
    const b = await createAppt(managerToken, {
      businessType: 'window_film',
      technicianName: '演示技师 C',
      workbench: `wb-${tag}-c`,
      ...slot(7, 2),
    });
    expect(b.status).toBe(409);
    expect((b.body as ErrorBody).code).toBe('APPOINTMENT_CONFLICT');
  });
});
