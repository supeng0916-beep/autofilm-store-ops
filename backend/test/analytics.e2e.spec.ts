import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface Overview {
  funnel: {
    total: number;
    touched: number;
    visited: number;
    won: number;
    lost: number;
    touchRate: number;
    closeRate: number;
    avgCloseDays: number | null;
  };
  revenueFen: number;
  avgDealFen: number | null;
  /** 毛利估算（批次4）：已录成本的已确认订单 Σ(收款−成本)，无数据为 null */
  grossProfitFen: number | null;
  bySource: Array<{ platform: string; total: number; won: number; revenueFen: number }>;
  lostReasons: Array<{ reason: string; count: number }>;
  workOrders: {
    total: number;
    delivered: number;
    reworkCount: number;
    reworkRate: number;
    byTechnician: Array<{
      name: string;
      total: number;
      delivered: number;
      rework: number;
      revenueFen: number;
    }>;
  };
  range: { scopedToOwner: boolean };
  /** 复购客户数（批次6）：范围内成交≥2 条客资的客户计数 */
  repeatCustomerCount: number;
}

/** 经营复盘集成测试（M10 最小版）：漏斗口径/金额/技师产能/权限范围 */
describe('经营复盘（M10 最小版）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  const tag = Math.random().toString(36).slice(2, 8);
  let bossToken = '';
  let salesToken = '';
  let recorderToken = '';
  let salesId = '';
  let sales2Id = '';

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

  /** 直建客资（绕过导入管道，控制统计字段） */
  const mkLead = (data: {
    ownerUserId?: string;
    stage: string;
    finalStatus?: string;
    won?: { closedAt: Date; amountFen: number };
    lost?: string;
    receivedAt?: Date;
    customerId?: string;
    sourcePlatform?: string;
  }) =>
    prisma.lead.create({
      data: {
        leadNo: `L-M10-${tag}-${Math.random().toString(36).slice(2, 10)}`,
        sourceCategory: 'online',
        sourcePlatform: data.sourcePlatform ?? `渠道-${tag}`,
        stage: data.stage,
        finalStatus: data.finalStatus ?? 'active',
        ownerUserId: data.ownerUserId,
        receivedAt: data.receivedAt ?? new Date(WIN_START),
        closedAt: data.won?.closedAt,
        closedAmountFen: data.won?.amountFen,
        closeReason: data.won ? '成交' : undefined,
        lostReason: data.lost,
        customerId: data.customerId,
      },
    });

  /** 唯一未来时间窗（+10 年）：测试库历史客资都在正常时间轴，天然排除 */
  const WIN_START = Date.now() + 10 * 365 * 86_400_000;
  const winQs = `?from=${new Date(WIN_START - 1000).toISOString()}&to=${new Date(WIN_START + 3_600_000).toISOString()}`;
  /** 批次6 复购客户独立窗口（主窗口再 +500 天），造数与既有断言互不干扰 */
  const REP_START = WIN_START + 500 * 86_400_000;
  const repQs = `?from=${new Date(REP_START - 1000).toISOString()}&to=${new Date(REP_START + 3_600_000).toISOString()}`;
  let repCustomerIds: string[] = [];

  const overview = (token: string, qs = '') =>
    request(app.getHttpServer() as Server)
      .get(`/api/v1/analytics/overview${qs}`)
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const boss = await mkUser(uniqueUsername('m10_boss'), 'boss');
    bossToken = boss.token;
    const sales = await mkUser(uniqueUsername('m10_sales'), 'sales_ops');
    salesToken = sales.token;
    salesId = sales.id;
    sales2Id = (await mkUser(uniqueUsername('m10_sales2'), 'sales_ops')).id;
    recorderToken = (await mkUser(uniqueUsername('m10_recorder'), 'recorder')).token;

    // 数据编排（全在近 30 天窗口内，渠道用 tag 隔离跨运行残留）
    // 销售1 名下：1 成交（¥29,500）+ 1 流失（价格贵）+ 1 新客资
    await mkLead({
      ownerUserId: salesId,
      stage: 'visit_done',
      finalStatus: 'won',
      won: { closedAt: new Date(WIN_START), amountFen: 2_680_000 },
    });
    await mkLead({
      ownerUserId: salesId,
      stage: 'communicating',
      finalStatus: 'lost',
      lost: '觉得价格贵',
    });
    await mkLead({ ownerUserId: salesId, stage: 'new' });
    // 销售2 名下：1 成交（¥5,300）——老板视角可见、销售1 视角不可见
    await mkLead({
      ownerUserId: sales2Id,
      stage: 'visit_done',
      finalStatus: 'won',
      won: { closedAt: new Date(WIN_START), amountFen: 498_000 },
    });
    // 窗口外数据：不计入
    await mkLead({
      ownerUserId: salesId,
      stage: 'visit_done',
      finalStatus: 'won',
      won: { closedAt: new Date(WIN_START), amountFen: 100_000 },
      receivedAt: new Date(WIN_START - 91 * 86_400_000), // 窗口外不计入
    });

    // —— 批次2 T5 造数：财务流水（1 条窗口外）/ 内容台账 / 画像 ——
    await prisma.financeEntry.createMany({
      data: [
        {
          direction: 'income',
          category: 'deal_receipt',
          amountFen: 100_000,
          occurredOn: new Date(WIN_START),
        },
        {
          direction: 'income',
          category: 'other',
          amountFen: 50_000,
          occurredOn: new Date(WIN_START + 1_800_000), // 窗口内（to=+1 小时）
        },
        {
          direction: 'expense',
          category: 'material',
          amountFen: 30_000,
          occurredOn: new Date(WIN_START),
        },
        {
          direction: 'income',
          category: 'other',
          amountFen: 999_999,
          occurredOn: new Date(WIN_START - 91 * 86_400_000), // 窗口外不计
        },
      ],
    });
    await prisma.contentRecord.create({
      data: {
        contentKey: `vid-${tag}`,
        title: '爆款车衣对比视频',
        platform: 'douyin',
        costFen: 20_000,
      },
    });
    await prisma.lead.updateMany({
      where: { sourcePlatform: `渠道-${tag}`, contentId: null },
      data: { contentId: `vid-${tag}` },
    });
    await prisma.lead.updateMany({
      where: { sourcePlatform: `渠道-${tag}`, gender: null },
      data: { gender: 'male', ageBand: '26-35' },
    });

    // —— 批次4 毛利估算造数：已确认订单（customerConfirmedAt 窗口内） ——
    // 客资 receivedAt 反推窗口外（−150 天）：不扰动漏斗/来源等按 receivedAt 的既有断言；
    // 毛利口径按 customerConfirmedAt 过滤，订单仍计入。
    const profitLeadA = await prisma.lead.create({
      data: {
        leadNo: `L-M10-${tag}-gp-a`,
        sourceCategory: 'offline',
        sourcePlatform: `毛利-${tag}`,
        stage: 'visit_done',
        finalStatus: 'won',
        ownerUserId: salesId,
        receivedAt: new Date(WIN_START - 150 * 86_400_000),
        closedAt: new Date(WIN_START - 150 * 86_400_000),
        closedAmountFen: 1_000_000,
        closeReason: '成交',
      },
    });
    const profitLeadB = await prisma.lead.create({
      data: {
        leadNo: `L-M10-${tag}-gp-b`,
        sourceCategory: 'offline',
        sourcePlatform: `毛利-${tag}`,
        stage: 'visit_done',
        finalStatus: 'won',
        ownerUserId: salesId,
        receivedAt: new Date(WIN_START - 150 * 86_400_000),
        closedAt: new Date(WIN_START - 150 * 86_400_000),
        closedAmountFen: 500_000,
        closeReason: '成交',
      },
    });
    await prisma.orderConfirmation.createMany({
      data: [
        {
          leadId: profitLeadA.id,
          products: 'DM04 全车',
          quoteSnapshot: `报价-${tag}-A`,
          depositFen: 400_000,
          balanceFen: 600_000,
          materialCostFen: 600_000, // 收 10000 元、成本 6000 元 → 毛利 4000 元
          status: 'confirmed',
          customerConfirmedAt: new Date(WIN_START + 300_000),
        },
        {
          leadId: profitLeadB.id,
          products: 'DM13 全车',
          quoteSnapshot: `报价-${tag}-B`,
          depositFen: 300_000,
          balanceFen: 200_000,
          // 未录材料成本 → 毛利口径不计入
          status: 'confirmed',
          customerConfirmedAt: new Date(WIN_START + 400_000),
        },
      ],
    });
    // —— 批次6 复购客户造数：独立远期窗口（+500 天），不扰动既有漏斗/金额断言 ——
    // 客户A 两条 won → 计 1；客户B 一条 won → 不计；客户C 两条未成交 → 不计；无 customerId 的 won → 不计
    const repCustomerA = await prisma.customer.create({
      data: { name: `复购甲-${tag}`, phone: `139${tag}0001`.slice(0, 11) },
    });
    const repCustomerB = await prisma.customer.create({
      data: { name: `复购乙-${tag}`, phone: `139${tag}0002`.slice(0, 11) },
    });
    const repCustomerC = await prisma.customer.create({
      data: { name: `复购丙-${tag}`, phone: `139${tag}0003`.slice(0, 11) },
    });
    repCustomerIds = [repCustomerA.id, repCustomerB.id, repCustomerC.id];
    for (const customerId of [repCustomerA.id, repCustomerA.id]) {
      await mkLead({
        ownerUserId: salesId,
        stage: 'visit_done',
        finalStatus: 'won',
        won: { closedAt: new Date(REP_START), amountFen: 100_000 },
        receivedAt: new Date(REP_START),
        customerId,
        sourcePlatform: `复购-${tag}`,
      });
    }
    await mkLead({
      ownerUserId: salesId,
      stage: 'visit_done',
      finalStatus: 'won',
      won: { closedAt: new Date(REP_START), amountFen: 100_000 },
      receivedAt: new Date(REP_START),
      customerId: repCustomerB.id,
      sourcePlatform: `复购-${tag}`,
    });
    for (let i = 0; i < 2; i++) {
      await mkLead({
        ownerUserId: salesId,
        stage: 'communicating',
        receivedAt: new Date(REP_START),
        customerId: repCustomerC.id,
        sourcePlatform: `复购-${tag}`,
      });
    }
    await mkLead({
      ownerUserId: salesId,
      stage: 'visit_done',
      finalStatus: 'won',
      won: { closedAt: new Date(REP_START), amountFen: 100_000 },
      receivedAt: new Date(REP_START),
      // 无 customerId：按口径不计入复购分桶
      sourcePlatform: `复购-${tag}`,
    });
  });

  afterAll(async () => {
    await prisma.financeEntry.deleteMany({
      where: { occurredOn: { gte: new Date(WIN_START - 92 * 86_400_000) } },
    });
    await prisma.contentRecord.deleteMany({ where: { contentKey: `vid-${tag}` } });
    // 批次4：毛利造数清理（确认单按报价快照前缀、客资按渠道前缀）
    await prisma.orderConfirmation.deleteMany({
      where: { quoteSnapshot: { startsWith: `报价-${tag}` } },
    });
    await prisma.lead.deleteMany({ where: { sourcePlatform: `毛利-${tag}` } });
    await prisma.lead.deleteMany({ where: { sourcePlatform: `渠道-${tag}` } });
    // 批次6：复购造数清理（先客资后客户档案）
    await prisma.lead.deleteMany({ where: { sourcePlatform: `复购-${tag}` } });
    await prisma.customer.deleteMany({ where: { id: { in: repCustomerIds } } });
    await app.close();
  });

  it('批次2 T5：财务三值/内容归因/画像分布', async () => {
    const res = await overview(bossToken, winQs).expect(200);
    const body = res.body as {
      finance: { incomeFen: number; expenseFen: number; netFen: number };
      contentAttribution: Array<{
        contentId: string;
        title: string | null;
        leadCount: number;
        revenueFen: number;
      }>;
      profile: {
        gender: Array<{ value: string; count: number }>;
        ageBand: Array<{ value: string; count: number }>;
      };
    };
    // 窗口内收入 1000+500=1500 元，支出 300 元，结余 1200 元（窗口外 9999.99 元不计）
    expect(body.finance.incomeFen).toBe(150_000);
    expect(body.finance.expenseFen).toBe(30_000);
    expect(body.finance.netFen).toBe(120_000);
    const row = body.contentAttribution.find((r) => r.contentId === `vid-${tag}`);
    expect(row?.title).toBe('爆款车衣对比视频');
    expect(row?.leadCount).toBeGreaterThanOrEqual(2);
    expect(row?.revenueFen).toBeGreaterThanOrEqual(0);
    expect(body.profile.gender.some((g) => g.value === 'male' && g.count >= 2)).toBe(true);
    expect(body.profile.ageBand.some((a) => a.value === '26-35' && a.count >= 2)).toBe(true);
  });

  it('批次4：毛利估算＝已录成本已确认订单 Σ(收款−成本)；无数据 null；销售视角 null', async () => {
    // 老板视角：窗口内 A 单收 10000 元、成本 6000 元 → 毛利恰 4000 元；
    // B 单未录成本不计入（若误计会得 9000 元）
    const res = await overview(bossToken, winQs).expect(200);
    expect((res.body as Overview).grossProfitFen).toBe(400_000);

    // 空窗口（无已录成本的确认订单）→ null（前端显示"—"）
    // 取 +200 年远窗：远离本库各套件造数时间轴，天然无数据
    const farBase = WIN_START + 200 * 365 * 86_400_000;
    const empty = await overview(
      bossToken,
      `?from=${new Date(farBase).toISOString()}&to=${new Date(farBase + 3_600_000).toISOString()}`,
    ).expect(200);
    expect((empty.body as Overview).grossProfitFen).toBeNull();

    // 销售视角：毛利属财务口径（同 finance 键），不下放 → null
    const salesRes = await overview(salesToken, winQs).expect(200);
    expect((salesRes.body as Overview).grossProfitFen).toBeNull();
  });

  it('批次6：复购客户计数——成交≥2 条客资的客户数', async () => {
    // 复购窗口：客户A 两条 won（计 1）；客户B 一条 won（不计）；客户C 两条未成交（不计）；
    // 无 customerId 的 won 一条（不计）→ 恰 1 位
    const res = await overview(bossToken, repQs).expect(200);
    expect((res.body as Overview).repeatCustomerCount).toBe(1);

    // 销售视角同窗口：客资均在 salesId 名下，计数一致（范围过滤不丢数据）
    const salesRes = await overview(salesToken, repQs).expect(200);
    expect((salesRes.body as Overview).repeatCustomerCount).toBe(1);

    // 主窗口：无带 customerId 的成交客资 → 0
    const main = await overview(bossToken, winQs).expect(200);
    expect((main.body as Overview).repeatCustomerCount).toBe(0);

    // 空窗口（无任何客资，自然无 won）→ 0
    const farBase = WIN_START + 300 * 365 * 86_400_000;
    const empty = await overview(
      bossToken,
      `?from=${new Date(farBase).toISOString()}&to=${new Date(farBase + 3_600_000).toISOString()}`,
    ).expect(200);
    expect((empty.body as Overview).repeatCustomerCount).toBe(0);
  });

  it('老板视角：漏斗/金额/来源/流失原因口径正确', async () => {
    const res = await overview(bossToken, winQs).expect(200);
    const body = res.body as Overview;
    // 窗口内 4 条：触达3、到店2、成交2、流失1；收入 29500+5300=31780 元
    expect(body.funnel.total).toBe(4);
    expect(body.funnel.touched).toBe(3);
    expect(body.funnel.visited).toBe(2);
    expect(body.funnel.won).toBe(2);
    expect(body.funnel.lost).toBe(1);
    expect(body.funnel.touchRate).toBe(0.75);
    expect(body.funnel.closeRate).toBe(0.5);
    expect(body.revenueFen).toBe(3_178_000);
    expect(body.avgDealFen).toBe(1_589_000);
    const src = body.bySource.find((s) => s.platform === `渠道-${tag}`);
    expect(src?.total).toBe(4);
    expect(src?.won).toBe(2);
    expect(src?.revenueFen).toBe(3_178_000);
    expect(body.lostReasons).toContainEqual({ reason: '觉得价格贵', count: 1 });
    expect(body.range.scopedToOwner).toBe(false);
  });

  it('销售视角：仅本人客资（他人的成交与收入不可见）', async () => {
    const res = await overview(salesToken, winQs).expect(200);
    const body = res.body as Overview;
    expect(body.funnel.total).toBe(3);
    expect(body.funnel.won).toBe(1);
    expect(body.revenueFen).toBe(2_680_000);
    expect(body.range.scopedToOwner).toBe(true);
  });

  it('控制面板：非全局角色可访问（回归——rechecks 曾用不存在的 lead 关系致 500）', async () => {
    // sales：走 owner 过滤路径（含待复检 leadId 范围谓词），不再 Prisma 校验错 500
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/analytics/dashboard')
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    expect((res.body as { scopedToOwner: boolean }).scopedToOwner).toBe(true);
    // recorder：同走非全局路径（m08:view 命中控制面板）
    await request(app.getHttpServer() as Server)
      .get('/api/v1/analytics/dashboard')
      .set('Authorization', `Bearer ${recorderToken}`)
      .expect(200);
  });

  it('施工产能：技师维度含交付/返工/产值（leadId 关联近似口径）', async () => {
    // 为销售1 的成交客资挂一张施工单（已交付无返工）+ 一张返工单
    // sales1 名下有窗口内外两条成交客资：orderBy 保证确定性取到窗口内那条
    // （无排序时 PG 返回顺序不定，曾致产值断言间歇为 0）
    const wonLead = await prisma.lead.findFirst({
      where: { ownerUserId: salesId, finalStatus: 'won', sourcePlatform: `渠道-${tag}` },
      orderBy: { receivedAt: 'desc' },
    });
    expect(wonLead).not.toBeNull();
    await prisma.workOrder.create({
      data: {
        orderNo: `W-M10-${tag}-0001`,
        leadId: wonLead!.id,
        technicianName: `黄师傅-${tag}`,
        stage: 'delivered',
        rework: false,
      },
    });
    await prisma.workOrder.create({
      data: {
        orderNo: `W-M10-${tag}-0002`,
        leadId: wonLead!.id,
        technicianName: `黄师傅-${tag}`,
        stage: 'in_progress',
        rework: true,
      },
    });
    const res = await overview(bossToken, winQs).expect(200);
    const wo = (res.body as Overview).workOrders;
    // 测试库可能有历史残留单：断言只看本 tag 技师的行
    const row = wo.byTechnician.find((t) => t.name === `黄师傅-${tag}`);
    expect(row?.total).toBe(2);
    expect(row?.delivered).toBe(1);
    expect(row?.rework).toBe(1);
    expect(row?.revenueFen).toBe(2_680_000); // 同一客资两张单按（技师×客资）去重计一次产值
    await prisma.workOrder.deleteMany({ where: { orderNo: { contains: `W-M10-${tag}` } } });
  });

  it('权限：记录员 403；时间窗参数非法 422', async () => {
    await overview(recorderToken).expect(403);
    const from = new Date().toISOString();
    const to = new Date(Date.now() - 86_400_000).toISOString();
    await overview(bossToken, `?from=${from}&to=${to}`).expect(422);
  });
});
