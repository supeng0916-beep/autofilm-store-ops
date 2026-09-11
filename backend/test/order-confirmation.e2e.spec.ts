import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { uniqueUsername } from './helpers/unique';
import { buildApp } from './setup';

interface OrderConfirmationBody {
  id: string;
  leadId: string;
  appointmentId: string | null;
  products: string;
  quoteSnapshot: string;
  discountNote: string | null;
  depositFen: number;
  balanceFen: number;
  materialCostFen: number | null;
  payMethod: string | null;
  status: string;
  customerConfirmedBy: string | null;
  customerConfirmedAt: string | null;
  createdBy: string | null;
}

/** 订单确认单集成测试（批次1 Task 7，M03 客资成交链）：报价快照 + 定金尾款记录。
 * 可选步骤、不作施工单闸门（老板已拍板 2026-09-01）——末例专门验证无确认单仍可建施工单。
 * 成交客资口径：prisma 直置 finalStatus='won'（与 lead-lifecycle.confirmWon 的落库口径一致，
 * 省去跟进链路，聚焦订单确认自身行为）。 */
describe('订单确认单（M03 · 批次1 Task 7）', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  const tag = Math.random().toString(36).slice(2, 8);
  /** 预约时段相对基准（当前+30 天）：2026-08-28 起后端拒绝过去时间 */
  const relBase = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  let salesToken = '';
  let salesId = '';
  let managerToken = '';
  let recorderToken = '';

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
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ username: uname, password });
    return { token: (res.body as { accessToken: string }).accessToken, id: user.id };
  };

  const api = (method: 'get' | 'post', url: string, token: string) =>
    request(server)[method](url).set('Authorization', `Bearer ${token}`);

  /** 合成客资：won=成交（直置 finalStatus='won'，口径同 confirmWon）；否则跟进中。
   * customer 选填：客户称呼/电话（欠款清单用例验证客资关联回读，批次5 Task 5） */
  const mkLead = async (
    suffix: string,
    won: boolean,
    customer?: { customerName: string; phone: string },
  ) =>
    prisma.lead.create({
      data: {
        leadNo: `L-OC7-${tag}-${suffix}`,
        sourceCategory: 'offline',
        sourcePlatform: 'walk-in-test',
        ownerUserId: salesId,
        finalStatus: won ? 'won' : 'active',
        ...(won ? { closedAt: new Date(), closedAmountFen: 1580000, closeReason: '测试成交' } : {}),
        ...(customer ?? {}),
      },
    });

  /** 建预约并走完店长审批 → 已确认预约 id。
   * 工位按套件随机 tag 唯一；日期/时刻取随机偏移——测试库与其他会话共享，
   * 固定时段会与并行套件的同技师预约撞冲突（409）。
   * 窗口选 3~9 天、6~15 时：避开 work-order.e2e（10+ 天 02-05 时）与
   * p6-replay（20+ 天）、appointment.e2e（0 天）的常用窗口。 */
  const baseDay = 3 + Math.floor(Math.random() * 7);
  const baseHour = 6 + Math.floor(Math.random() * 10);
  let slotSeq = 0;
  const confirmedAppointment = async (extra: Record<string, unknown> = {}) => {
    slotSeq += 1;
    const day = baseDay + slotSeq;
    const created = await api('post', '/api/v1/appointments', salesToken)
      .send({
        customerId: `cust-oc7-${tag}-${slotSeq}`,
        serviceItem: `DM04 隔热膜-${tag}`,
        businessType: 'car_cover',
        workbench: `OC7${tag}-${slotSeq}`,
        technicianName: '演示技师 B',
        startAt: new Date(
          Date.UTC(
            relBase.getUTCFullYear(),
            relBase.getUTCMonth(),
            relBase.getUTCDate() + day,
            baseHour,
          ),
        ).toISOString(),
        endAt: new Date(
          Date.UTC(
            relBase.getUTCFullYear(),
            relBase.getUTCMonth(),
            relBase.getUTCDate() + day,
            baseHour + 3,
          ),
        ).toISOString(),
        ...extra,
      })
      .expect(201);
    const apptId = (created.body as { appointment: { id: string } }).appointment.id;
    const list = await api('get', '/api/v1/approvals?status=pending', managerToken).expect(200);
    const item = (
      list.body as Array<{ id: string; type: string; payload: { appointmentId?: string } }>
    ).find((a) => a.type === 'm07.schedule.confirm' && a.payload.appointmentId === apptId);
    expect(item).toBeDefined();
    await api('post', `/api/v1/approvals/${item!.id}/approve`, managerToken)
      .send({ confirmed: true })
      .expect(201);
    return apptId;
  };

  beforeAll(async () => {
    app = await buildApp();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    // 同日重跑残留防御（2026-09-01，同 p6-replay/work-order 四套件）
    await prisma.workOrder.deleteMany({});
    await prisma.appointmentTechnicianChange.deleteMany({});
    await prisma.appointment.deleteMany({});
    auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const sales = await mkUser(uniqueUsername('oc7_sales'), 'sales_ops');
    salesToken = sales.token;
    salesId = sales.id;
    managerToken = (await mkUser(uniqueUsername('oc7_manager'), 'store_manager')).token;
    recorderToken = (await mkUser(uniqueUsername('oc7_recorder'), 'recorder')).token;
  });

  afterAll(async () => {
    // 清本套件痕迹：确认单 → 回访/施工单/预约 → 客资（表间无 FK 级联，逐层删防悬空引用）。
    // 注意1 orderConfirmation.leadId 存客资 cuid（非 leadNo），须先按 leadNo 前缀取 id 集合；
    // 注意2 工位经 normalizeWorkbench 落库为大写，清理按大写口径（先例 appointment.e2e.spec.ts）
    const benchTag = tag.toUpperCase();
    const leadIds = (
      await prisma.lead.findMany({
        where: { leadNo: { startsWith: `L-OC7-${tag}` } },
        select: { id: true },
      })
    ).map((l) => l.id);
    await prisma.orderConfirmation.deleteMany({ where: { leadId: { in: leadIds } } });
    const woIds = (
      await prisma.workOrder.findMany({ where: { workbench: { contains: benchTag } } })
    ).map((w) => w.id);
    await prisma.aftercareVisit.deleteMany({ where: { workOrderId: { in: woIds } } });
    await prisma.workOrder.deleteMany({ where: { workbench: { contains: benchTag } } });
    await prisma.appointment.deleteMany({ where: { workbench: { contains: benchTag } } });
    await prisma.lead.deleteMany({ where: { leadNo: { startsWith: `L-OC7-${tag}` } } });
    await app.close();
  });

  it('won 客资创建订单确认单 → 201，status=draft，金额分为单位', async () => {
    const lead = await mkLead('A', true);
    const res = await api('post', '/api/v1/order-confirmations', salesToken)
      .send({
        leadId: lead.id,
        products: 'DM04 前挡 + DM13 侧后挡 + 车衣',
        quoteSnapshot: '报价单 Q-1：总价 15800.00 元，含 8 年质保',
        discountNote: '店长批价让利 200 元',
        depositFen: 500000,
        balanceFen: 1080000,
        materialCostFen: 600000, // 材料成本 6000.00 元（批次4 毛利估算，选填）
        payMethod: 'wechat',
      })
      .expect(201);
    const oc = res.body as OrderConfirmationBody;
    expect(oc.leadId).toBe(lead.id);
    expect(oc.status).toBe('draft');
    expect(oc.depositFen).toBe(500000); // 定金 5000.00 元（分为单位）
    expect(oc.balanceFen).toBe(1080000); // 尾款 10800.00 元
    expect(oc.materialCostFen).toBe(600000); // 材料成本原值回读
    expect(oc.payMethod).toBe('wechat');
    expect(oc.customerConfirmedAt).toBeNull();
    expect(oc.createdBy).toBe(salesId);

    // 按 leadId 查询可回读
    const list = await api(
      'get',
      `/api/v1/order-confirmations?leadId=${lead.id}`,
      salesToken,
    ).expect(200);
    const rows = list.body as OrderConfirmationBody[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(oc.id);
    expect(rows[0].quoteSnapshot).toContain('报价单 Q-1');
    expect(rows[0].materialCostFen).toBe(600000); // 列表回读同值

    // 审计留痕：创建动作
    const audit = await prisma.auditLog.findMany({
      where: { objectType: 'order_confirmation', objectId: oc.id },
    });
    expect(audit.map((a) => a.action)).toContain('order_confirmation.created');
  });

  it('材料成本选填（批次4）：不传 → null；负数 → 400', async () => {
    const lead = await mkLead('A2', true);
    const res = await api('post', '/api/v1/order-confirmations', salesToken)
      .send({
        leadId: lead.id,
        products: 'DM04 前挡',
        quoteSnapshot: '报价单 Q-1b',
        depositFen: 100000,
      })
      .expect(201);
    expect((res.body as OrderConfirmationBody).materialCostFen).toBeNull();

    // 负数材料成本被 zod nonnegative 拦截（400，不落库）
    await api('post', '/api/v1/order-confirmations', salesToken)
      .send({
        leadId: lead.id,
        products: 'DM04 前挡',
        quoteSnapshot: '报价单 Q-1b',
        materialCostFen: -1,
      })
      .expect(400);
    expect(await prisma.orderConfirmation.count({ where: { leadId: lead.id } })).toBe(1);
  });

  it('未成交客资创建 → 422（订单只能挂在成交客资上）', async () => {
    const lead = await mkLead('B', false);
    const res = await api('post', '/api/v1/order-confirmations', salesToken)
      .send({
        leadId: lead.id,
        products: 'DM04 前挡',
        quoteSnapshot: '报价单 Q-2',
      })
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
    expect((res.body as { message: string }).message).toContain('成交');
    expect(await prisma.orderConfirmation.count({ where: { leadId: lead.id } })).toBe(0);
  });

  it('同一 lead 重复创建 → 409', async () => {
    const lead = await mkLead('C', true);
    await api('post', '/api/v1/order-confirmations', salesToken)
      .send({ leadId: lead.id, products: 'DM04', quoteSnapshot: '报价单 Q-3' })
      .expect(201);
    const dup = await api('post', '/api/v1/order-confirmations', salesToken)
      .send({ leadId: lead.id, products: 'DM04', quoteSnapshot: '报价单 Q-3 复制' })
      .expect(409);
    expect((dup.body as { code: string }).code).toBe('ORDER_INVALID_STATE');
    expect(await prisma.orderConfirmation.count({ where: { leadId: lead.id } })).toBe(1);
  });

  it('confirm → status=confirmed+customerConfirmedAt；重复 confirm → 409', async () => {
    const lead = await mkLead('D', true);
    const created = await api('post', '/api/v1/order-confirmations', salesToken)
      .send({
        leadId: lead.id,
        products: 'DM04',
        quoteSnapshot: '报价单 Q-4',
        depositFen: 10000,
      })
      .expect(201);
    const id = (created.body as OrderConfirmationBody).id;

    const confirmed = await api('post', `/api/v1/order-confirmations/${id}/confirm`, salesToken)
      .send({})
      .expect(200);
    const oc = confirmed.body as OrderConfirmationBody;
    expect(oc.status).toBe('confirmed');
    expect(oc.customerConfirmedAt).not.toBeNull();
    expect(oc.customerConfirmedBy).toBe(salesId);

    // 重复确认 → 409（终态防重）
    const again = await api('post', `/api/v1/order-confirmations/${id}/confirm`, salesToken)
      .send({})
      .expect(409);
    expect((again.body as { code: string }).code).toBe('ORDER_INVALID_STATE');

    // 不存在的确认单 → 404
    await api('post', '/api/v1/order-confirmations/nonexistent/confirm', salesToken)
      .send({})
      .expect(404);

    // 审计留痕：确认动作
    const audit = await prisma.auditLog.findMany({
      where: { objectType: 'order_confirmation', objectId: id },
    });
    expect(audit.map((a) => a.action)).toContain('order_confirmation.confirmed');
  });

  it('施工单创建不受订单确认影响（可选步骤非闸门）：无订单确认仍可建单', async () => {
    const lead = await mkLead('E', true);
    // 客资关联预约并走完审批（真实施工链入口）
    const apptId = await confirmedAppointment({ leadId: lead.id });
    const res = await api('post', '/api/v1/work-orders', recorderToken)
      .send({ appointmentId: apptId })
      .expect(201);
    const wo = res.body as { id: string; stage: string; leadId: string | null };
    expect(wo.stage).toBe('pending');
    expect(wo.leadId).toBe(lead.id);
    // 全程未建订单确认单——施工单照常创建（无闸门）
    expect(await prisma.orderConfirmation.count({ where: { leadId: lead.id } })).toBe(0);
  });

  it('欠款清单（批次5）：confirmed+尾款>0 出现并带客资称呼/电话；尾款=0 与 draft 不出现', async () => {
    // ① confirmed 且尾款>0 → 出现在清单，含客资称呼/电话
    const lead1 = await mkLead('F1', true, { customerName: '车主冯先生', phone: '13800001111' });
    const created = await api('post', '/api/v1/order-confirmations', salesToken)
      .send({
        leadId: lead1.id,
        products: 'DM04 前挡',
        quoteSnapshot: '报价单 Q-F1',
        depositFen: 300000,
        balanceFen: 700000,
      })
      .expect(201);
    const ocId = (created.body as OrderConfirmationBody).id;
    await api('post', `/api/v1/order-confirmations/${ocId}/confirm`, salesToken)
      .send({})
      .expect(200);

    // ② confirmed 但尾款=0 → 不出现（已结清）
    const lead2 = await mkLead('F2', true);
    const settled = await api('post', '/api/v1/order-confirmations', salesToken)
      .send({
        leadId: lead2.id,
        products: 'DM04 前挡',
        quoteSnapshot: '报价单 Q-F2',
        depositFen: 500000,
        balanceFen: 0,
      })
      .expect(201);
    await api(
      'post',
      `/api/v1/order-confirmations/${(settled.body as OrderConfirmationBody).id}/confirm`,
      salesToken,
    )
      .send({})
      .expect(200);

    // ③ draft 且尾款>0 → 不出现（客户未确认）
    const lead3 = await mkLead('F3', true);
    await api('post', '/api/v1/order-confirmations', salesToken)
      .send({
        leadId: lead3.id,
        products: 'DM04 前挡',
        quoteSnapshot: '报价单 Q-F3',
        depositFen: 100000,
        balanceFen: 800000,
      })
      .expect(201);

    const res = await api('get', '/api/v1/order-confirmations/arrears', managerToken).expect(200);
    const rows = res.body as Array<{
      id: string;
      leadId: string;
      depositFen: number;
      balanceFen: number;
      customerConfirmedAt: string | null;
      customerName: string | null;
      phone: string | null;
    }>;
    // 测试库与并行会话共享：只按本用例客资过滤断言，不断言全库总数
    const mine = rows.filter((r) => [lead1.id, lead2.id, lead3.id].includes(r.leadId));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      id: ocId,
      leadId: lead1.id,
      depositFen: 300000,
      balanceFen: 700000,
      customerName: '车主冯先生',
      phone: '13800001111',
    });
    expect(mine[0].customerConfirmedAt).not.toBeNull();
  });

  it('欠款清单（批次5）：无权限角色（recorder）403', async () => {
    await api('get', '/api/v1/order-confirmations/arrears', recorderToken).expect(403);
  });
});
