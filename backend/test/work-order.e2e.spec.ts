import { existsSync } from 'node:fs';

import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { VisitService } from '../src/modules/aftercare/visit.service';
import { AiTaskRegistry } from '../src/modules/ai-dispatch/ai-dispatch.registry';
import { AuthService } from '../src/modules/auth/auth.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface WoBody {
  id: string;
  orderNo: string;
  stage: string;
  serviceItem: string | null;
  businessType: string | null;
  technicianName: string | null;
  workbench: string | null;
  leadId: string | null;
  customerId: string | null;
  backfilled: boolean;
  backfillForAt: string | null;
  rework: boolean;
  reworkRecords?: Array<{ reason: string }> | null;
  photos?: Array<{ path: string }> | null;
  abnormal?: Array<{ description: string }> | null;
  careNotes?: { draft: string; sources: unknown[]; confirmed?: { by: string } } | null;
  caseRequest?: { authorized: boolean } | null;
  deliveredBy: string | null;
}

/** 施工单集成测试（P5-04/05/06）：阶段状态机 + 三真人确认 + 补录 + 案例回流 + AI 边界 */
describe('施工单模块（M08 · P5-04~06）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  const tag = Math.random().toString(36).slice(2, 8);
  /** 预约时段相对基准（当前+30 天）：2026-08-28 起后端拒绝过去时间 */
  const relBase = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  let managerToken = '';
  let recorderToken = '';
  let salesToken = '';
  let salesId = '';
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

  const api = (method: 'get' | 'post', url: string, token: string) =>
    request(app.getHttpServer() as Server)
      [method](url)
      .set('Authorization', `Bearer ${token}`);

  /** 建预约并走完店长审批 → 返回已确认预约 id。
   * 每次调用自增序号：工位与日期唯一，避免同技师/工位时段自我冲突 */
  let seq = 0;
  const confirmedAppointment = async (extra: Record<string, unknown> = {}) => {
    seq += 1;
    const day = 10 + seq;
    const created = await api('post', '/api/v1/appointments', salesToken)
      .send({
        customerId: `cust-${tag}`,
        serviceItem: `DM10 隔热膜-${tag}`,
        businessType: 'car_cover',
        workbench: `WO${tag}-${seq}`,
        technicianName: '演示技师 B',
        startAt: new Date(
          Date.UTC(relBase.getUTCFullYear(), relBase.getUTCMonth(), relBase.getUTCDate() + day, 2),
        ).toISOString(),
        endAt: new Date(
          Date.UTC(relBase.getUTCFullYear(), relBase.getUTCMonth(), relBase.getUTCDate() + day, 5),
        ).toISOString(),
        ...extra,
      })
      .expect(201);
    const apptId = (created.body as { appointment: { id: string } }).appointment.id;
    const list = await api('get', '/api/v1/approvals?status=pending', managerToken).expect(200);
    const item = (
      list.body as Array<{ id: string; type: string; payload: { appointmentId?: string } }>
    ).find((a) => a.type === 'm07.schedule.confirm' && a.payload.appointmentId === apptId);
    await api('post', `/api/v1/approvals/${item!.id}/approve`, managerToken)
      .send({ confirmed: true })
      .expect(201);
    return apptId;
  };

  /** 建施工单并推进到指定阶段 */
  const woAt = async (stage: string) => {
    const apptId = await confirmedAppointment();
    const created = await api('post', '/api/v1/work-orders', recorderToken)
      .send({ appointmentId: apptId })
      .expect(201);
    const wo = created.body as WoBody;
    if (stage === 'pending') return wo;
    await api('post', `/api/v1/work-orders/${wo.id}/start`, recorderToken).expect(200);
    if (stage === 'in_progress') return wo;
    await api('post', `/api/v1/work-orders/${wo.id}/self-check`, recorderToken)
      .send({ note: '自检无气泡' })
      .expect(200);
    if (stage === 'self_check_done') return wo;
    await api('post', `/api/v1/work-orders/${wo.id}/recheck`, managerToken)
      .send({ note: '复检合格' })
      .expect(200);
    if (stage === 'recheck_done') return wo;
    await api('post', `/api/v1/work-orders/${wo.id}/deliver`, managerToken)
      .send({ note: '客户验收交付' })
      .expect(200);
    return wo;
  };

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
    const manager = await mkUser(uniqueUsername('wo_manager'), 'store_manager');
    managerToken = manager.token;
    managerId = manager.id;
    const recorder = await mkUser(uniqueUsername('wo_recorder'), 'recorder');
    recorderToken = recorder.token;
    const sales = await mkUser(uniqueUsername('wo_sales'), 'sales_ops');
    salesToken = sales.token;
    salesId = sales.id;
  });

  afterAll(async () => {
    // M09 交付钩子：本套件各交付用例均会生成回访——删施工单前先清对应 visit（表无 FK，避免悬空引用）
    const woIds = (await prisma.workOrder.findMany({ select: { id: true } })).map((w) => w.id);
    await prisma.aftercareVisit.deleteMany({ where: { workOrderId: { in: woIds } } });
    await prisma.workOrder.deleteMany({ where: { orderNo: { contains: '' } } });
    await prisma.appointment.deleteMany({ where: { workbench: { contains: tag } } });
    await app.close();
  });

  it('P5-04 未确认排期不得建施工单；确认后创建成功并快照预约字段', async () => {
    const created = await api('post', '/api/v1/appointments', salesToken)
      .send({
        customerId: `cust-${tag}`,
        serviceItem: `DM10 隔热膜-${tag}`,
        businessType: 'car_cover',
        workbench: `WO${tag}B`,
        startAt: new Date(
          Date.UTC(relBase.getUTCFullYear(), relBase.getUTCMonth(), relBase.getUTCDate() + 3, 2),
        ).toISOString(),
        endAt: new Date(
          Date.UTC(relBase.getUTCFullYear(), relBase.getUTCMonth(), relBase.getUTCDate() + 3, 5),
        ).toISOString(),
      })
      .expect(201);
    const pendingAppt = (created.body as { appointment: { id: string } }).appointment.id;
    const rejected = await api('post', '/api/v1/work-orders', recorderToken)
      .send({ appointmentId: pendingAppt })
      .expect(409);
    expect((rejected.body as { code: string }).code).toBe('WORK_ORDER_INVALID_STATE');

    const apptId = await confirmedAppointment({ workbench: `WO${tag}C` });
    const res = await api('post', '/api/v1/work-orders', recorderToken)
      .send({ appointmentId: apptId })
      .expect(201);
    const wo = res.body as WoBody;
    expect(wo.orderNo).toMatch(/^W-\d{8}-\d{4}$/);
    expect(wo.stage).toBe('pending');
    expect(wo.serviceItem).toContain('DM10');
    expect(wo.businessType).toBe('car_cover');
    expect(wo.technicianName).toBe('演示技师 B');
    expect(wo.customerId).toBe(`cust-${tag}`);
  });

  it('2026-08-28 bug3（方案A）：预约无技师 → 建单未指定技师 422；指定后正常建单', async () => {
    // confirmedAppointment 默认带技师演示技师 B，这里用 undefined 覆盖建一单无技师预约
    const apptId = await confirmedAppointment({
      workbench: `WO${tag}T`,
      technicianName: undefined,
    });
    const rejected = await api('post', '/api/v1/work-orders', recorderToken)
      .send({ appointmentId: apptId })
      .expect(422);
    expect((rejected.body as { code: string }).code).toBe('VALIDATION_FAILED');
    const res = await api('post', '/api/v1/work-orders', recorderToken)
      .send({ appointmentId: apptId, technicianName: '演示技师 B' })
      .expect(201);
    expect((res.body as WoBody).technicianName).toBe('演示技师 B');
  });

  it('2026-08-28 P1：建单现场选技师须过技能池校验（窗膜技师派车衣单 422）', async () => {
    // 演示技师 A具有 window_film / color_change 技能，车衣预约（默认 car_cover）建单选他 → 技能池硬校验拦截；
    // 换有 car_cover 技能的技师即建单成功。此前该路径只校验「选没选」不校验「会不会」
    const apptId = await confirmedAppointment({
      workbench: `WO${tag}-SKILL`,
      technicianName: undefined,
    });
    const rejected = await api('post', '/api/v1/work-orders', recorderToken)
      .send({ appointmentId: apptId, technicianName: '演示技师 A' })
      .expect(422);
    expect((rejected.body as { code: string }).code).toBe('TECHNICIAN_SKILL_MISMATCH');
    expect((rejected.body as { message: string }).message).toContain('演示技师 A');

    const res = await api('post', '/api/v1/work-orders', recorderToken)
      .send({ appointmentId: apptId, technicianName: '演示技师 B' })
      .expect(201);
    expect((res.body as WoBody).technicianName).toBe('演示技师 B');
  });

  it('2026-08-28 bug4：同一预约重复建施工单 409（返工走原单）', async () => {
    const apptId = await confirmedAppointment({ workbench: `WO${tag}-DUP` });
    const first = await api('post', '/api/v1/work-orders', recorderToken)
      .send({ appointmentId: apptId })
      .expect(201);
    const orderNo = (first.body as { orderNo: string }).orderNo;
    const dup = await api('post', '/api/v1/work-orders', recorderToken)
      .send({ appointmentId: apptId })
      .expect(409);
    expect((dup.body as { message: string }).message).toContain(orderNo);
  });

  it('P5-05 阶段状态机：跳步被拒；自检(补录)→复检→交付三真人节点留痕', async () => {
    const wo = await woAt('pending');
    // 跳步：pending 直接交付/复检 → 409
    await api('post', `/api/v1/work-orders/${wo.id}/deliver`, managerToken).send({}).expect(409);
    await api('post', `/api/v1/work-orders/${wo.id}/recheck`, managerToken).send({}).expect(409);

    await api('post', `/api/v1/work-orders/${wo.id}/start`, recorderToken).expect(200);
    // 自检带原时间（受控补录）：backfilled + backfillForAt
    const occurredAt = new Date(Date.UTC(2026, 8, 2, 6)).toISOString();
    const self = await api('post', `/api/v1/work-orders/${wo.id}/self-check`, recorderToken)
      .send({ note: '技师自检通过', occurredAt })
      .expect(200);
    expect((self.body as WoBody).backfilled).toBe(true);
    expect((self.body as WoBody).backfillForAt).toBe(occurredAt);

    await api('post', `/api/v1/work-orders/${wo.id}/recheck`, managerToken)
      .send({ note: '店长复检合格' })
      .expect(200);
    const delivered = await api('post', `/api/v1/work-orders/${wo.id}/deliver`, managerToken)
      .send({ note: '客户验收' })
      .expect(200);
    expect((delivered.body as WoBody).stage).toBe('delivered');
    expect((delivered.body as WoBody).deliveredBy).toBe(managerId);
    // 终态后再推进 → 409
    await api('post', `/api/v1/work-orders/${wo.id}/start`, recorderToken).expect(409);
  });

  it('P5-04 权限：sales 不能录入/开工（403），recorder 不能复检（403）', async () => {
    const apptId = await confirmedAppointment({ workbench: `WO${tag}P` });
    await api('post', '/api/v1/work-orders', salesToken)
      .send({ appointmentId: apptId })
      .expect(403);
    const wo = await woAt('pending');
    await api('post', `/api/v1/work-orders/${wo.id}/start`, salesToken).expect(403);
    // sales 开工被拒（无副作用），记录员正式开工后自检
    await api('post', `/api/v1/work-orders/${wo.id}/start`, recorderToken).expect(200);
    await api('post', `/api/v1/work-orders/${wo.id}/self-check`, recorderToken)
      .send({})
      .expect(200);
    await api('post', `/api/v1/work-orders/${wo.id}/recheck`, recorderToken).send({}).expect(403);
  });

  it('P5-04 sales 视野：仅本人客资关联可见（列表与详情）', async () => {
    const lead = await prisma.lead.create({
      data: {
        leadNo: `L-WO-${tag}`,
        sourceCategory: 'online',
        sourcePlatform: 'test',
        ownerUserId: salesId,
      },
    });
    const apptOwn = await confirmedAppointment({ workbench: `WO${tag}S1`, leadId: lead.id });
    const createdOwn = await api('post', '/api/v1/work-orders', recorderToken)
      .send({ appointmentId: apptOwn })
      .expect(201);
    const own = createdOwn.body as WoBody;
    expect(own.leadId).toBe(lead.id);

    const apptOther = await confirmedAppointment({ workbench: `WO${tag}S2` });
    const createdOther = await api('post', '/api/v1/work-orders', recorderToken)
      .send({ appointmentId: apptOther })
      .expect(201);
    const other = createdOther.body as WoBody;

    const list = await api('get', '/api/v1/work-orders', salesToken).expect(200);
    const ids = (list.body as Array<{ id: string }>).map((w) => w.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(other.id);
    // 详情越权按不存在处理
    await api('get', `/api/v1/work-orders/${other.id}`, salesToken).expect(404);
    await api('get', `/api/v1/work-orders/${own.id}`, salesToken).expect(200);
  });

  it('P5-05 返工：独立记录可回溯，退回施工中后可重新走完流程', async () => {
    const wo = await woAt('recheck_done');
    const res = await api('post', `/api/v1/work-orders/${wo.id}/rework`, managerToken)
      .send({ reason: '右后窗膜面有尘点' })
      .expect(200);
    const body = res.body as WoBody;
    expect(body.stage).toBe('in_progress');
    expect(body.rework).toBe(true);
    expect(body.reworkRecords?.[0]?.reason).toBe('右后窗膜面有尘点');
    // 重新走完
    await api('post', `/api/v1/work-orders/${wo.id}/self-check`, recorderToken)
      .send({})
      .expect(200);
    await api('post', `/api/v1/work-orders/${wo.id}/recheck`, managerToken).send({}).expect(200);
    await api('post', `/api/v1/work-orders/${wo.id}/deliver`, managerToken).send({}).expect(200);
  });

  it('P5-04 照片：multipart 落本地存储、路径入库；非图片被拒；交付后拒补', async () => {
    const wo = await woAt('in_progress');
    const png1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    // 非图片 MIME → 400（白名单拦截）
    await api('post', `/api/v1/work-orders/${wo.id}/photos`, recorderToken)
      .field('note', '测试')
      .attach('file', Buffer.from('not an image'), { filename: 'a.txt', contentType: 'text/plain' })
      .expect(400);
    // 缺文件 → 400
    await api('post', `/api/v1/work-orders/${wo.id}/photos`, recorderToken)
      .field('note', '测试')
      .expect(400);
    const res = await api('post', `/api/v1/work-orders/${wo.id}/photos`, recorderToken)
      .field('note', '施工前')
      .attach('file', png1x1, { filename: '前挡.png', contentType: 'image/png' })
      .expect(200);
    const photoPath = (res.body as WoBody).photos?.[0]?.path;
    expect(photoPath).toBeTruthy();
    expect(existsSync(photoPath!)).toBe(true);

    await api('post', `/api/v1/work-orders/${wo.id}/abnormal`, recorderToken)
      .send({ description: '客户车辆原有划痕，已拍照确认' })
      .expect(200);
    const abnormal = await api('get', `/api/v1/work-orders/${wo.id}`, recorderToken).expect(200);
    expect((abnormal.body as WoBody).abnormal?.[0]?.description).toContain('划痕');
  });

  it('P5-05 养护说明：知识库确定性草稿带来源，人工确认留痕', async () => {
    await prisma.knowledgeItem.create({
      data: {
        kind: 'warranty',
        key: `warranty-wo-${tag}`,
        title: '隔热膜质保政策',
        content: '施工后 7 天内不洗车，30 天内不贴吸附件，质保 8 年',
        source: '演示品牌官方质保手册',
        status: 'active',
        licensed: true,
        createdBy: managerId,
      },
    });
    const wo = await woAt('self_check_done');
    const draft = await api(
      'get',
      `/api/v1/work-orders/${wo.id}/care-notes/draft`,
      recorderToken,
    ).expect(200);
    const care = (draft.body as WoBody).careNotes;
    expect(care?.draft).toContain('隔热膜质保政策');
    expect(care?.draft).toContain('草稿');
    expect(care?.sources.length).toBeGreaterThan(0);
    expect(care?.confirmed).toBeUndefined();

    const confirmed = await api(
      'post',
      `/api/v1/work-orders/${wo.id}/care-notes/confirm`,
      managerToken,
    )
      .send({ content: '确认按此说明交付客户' })
      .expect(200);
    expect((confirmed.body as WoBody).careNotes?.confirmed?.by).toBe(managerId);
  });

  it('P5-06 案例回流：未授权零写入；授权写知识库案例草稿（licensed + 来源）', async () => {
    const wo = await woAt('delivered');
    // 未授权：不产生任何知识条目
    const before = await prisma.knowledgeItem.count({ where: { kind: 'case' } });
    await api('post', `/api/v1/work-orders/${wo.id}/case-request`, managerToken)
      .send({ authorized: false, method: 'wechat', note: '客户婉拒公开' })
      .expect(200);
    expect(await prisma.knowledgeItem.count({ where: { kind: 'case' } })).toBe(before);

    // 授权 → 案例草稿
    const res = await api('post', `/api/v1/work-orders/${wo.id}/case-request`, managerToken)
      .send({ authorized: true, method: 'wechat', note: '客户同意展示' })
      .expect(200);
    expect((res.body as WoBody).caseRequest?.authorized).toBe(true);
    const item = await prisma.knowledgeItem.findFirst({
      where: { kind: 'case', key: `case-${wo.orderNo.toLowerCase()}` },
    });
    expect(item).toBeDefined();
    expect(item?.licensed).toBe(true);
    expect(item?.source).toBe(`work_order:${wo.orderNo}`);
    expect(item?.status).toBe('draft'); // 仍需 M06 生效流程（版本/审批）

    // 未交付不能询问授权
    const wo2 = await woAt('recheck_done');
    await api('post', `/api/v1/work-orders/${wo2.id}/case-request`, managerToken)
      .send({ authorized: true })
      .expect(409);
  });

  it('M09 交付钩子：交付确认自动生成 d7/d30 回访；重复交付路径不产生多余计划', async () => {
    const day = 24 * 3600 * 1000;
    const wo = await woAt('delivered');

    // 交付成功即两条回访：plan 集合恰为 {d7, d30}，均 pending
    const rows = await prisma.aftercareVisit.findMany({ where: { workOrderId: wo.id } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.plan).sort()).toEqual(['d30', 'd7']);
    for (const r of rows) expect(r.status).toBe('pending');

    // dueAt = 交付时间 +7/+30 天；customerId 随施工单客户快照
    const order = await prisma.workOrder.findUniqueOrThrow({ where: { id: wo.id } });
    const d7 = rows.find((r) => r.plan === 'd7')!;
    const d30 = rows.find((r) => r.plan === 'd30')!;
    expect(d7.dueAt.getTime()).toBe(order.deliveredAt!.getTime() + 7 * day);
    expect(d30.dueAt.getTime()).toBe(order.deliveredAt!.getTime() + 30 * day);
    expect(d7.customerId).toBe(`cust-${tag}`);
    expect(d30.customerId).toBe(`cust-${tag}`);

    // 重复交付路径：终态 409 不重复触发钩子；幂等闸直调同样不多建
    await api('post', `/api/v1/work-orders/${wo.id}/deliver`, managerToken).send({}).expect(409);
    const svc = app.get(VisitService);
    expect(await svc.planForWorkOrder(wo.id, `cust-${tag}`, order.deliveredAt!)).toBe(0);
    expect(await prisma.aftercareVisit.count({ where: { workOrderId: wo.id } })).toBe(2);
  });

  it('P5-05 AI 边界：ai-dispatch 注册表无任何施工/质检类 taskType（无模型判定合格路径）', () => {
    const registry = app.get(AiTaskRegistry);
    const types = registry.list().map((d) => d.taskType);
    const forbidden = types.filter((t) =>
      /work.?order|quality|qc|judge|inspect|recheck|deliver|self.?check/.test(t),
    );
    expect(forbidden).toEqual([]);
    // 现有通道任务全部为整理/检索/草拟类
    expect(types.length).toBeGreaterThan(0);
  });
});
