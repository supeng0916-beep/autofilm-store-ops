import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface SearchItem {
  id: string;
  title: string;
  sub: string;
  link: string;
  snippet?: string | null;
}

interface SearchBody {
  q: string;
  sections: Array<{ type: string; items: SearchItem[] }>;
}

/** 全局搜索集成测试（V2.3a）：统一端点四分节 + 角色分节可见 + sales 范围谓词 + PII 边界 */
describe('全局搜索（V2.3a）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  // 双 tag：tag 编排 boss 全节命中；tag2 编排 sales 本人/他人范围（互不串扰）
  const tag = Math.random().toString(36).slice(2, 8);
  const tag2 = Math.random().toString(36).slice(2, 8);
  // tag3：素材节（V2.3b）——独立编排，避免污染 boss 四节精确断言
  const tag3 = Math.random().toString(36).slice(2, 8);
  // tag4：类别筛选/命中片段/类别计数（2026-08-21）——关键词只进 content，验证 snippet
  const tag4 = Math.random().toString(36).slice(2, 8);
  let bossToken = '';
  let bossId = '';
  let salesToken = '';
  let salesId = '';
  let sales2Id = '';
  let recorderToken = '';
  let sysAdminToken = '';

  // tag 数据（boss 四节各 1）
  let lead1 = { id: '' };
  let k1 = { id: '' };
  let appt1 = { id: '' };
  let wo1 = { id: '' };
  // tag2 数据（sales 范围：本人 vs 他人）
  let leadOwn = { id: '' };
  let leadOther = { id: '' };
  let apptOwn = { id: '' };
  let apptOther = { id: '' };
  let woOwn = { id: '' };
  let woOther = { id: '' };
  // tag3 数据（素材节：licensed=false 亦对内可搜——对外引用限制在 knowledge.search 口径）
  let asset1 = { id: '' };
  // tag4 数据（命中片段/关联度排序）：标题命中条目 + 两条仅 content 命中
  let kTitle = { id: '' };

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

  const search = (token: string, q: string) =>
    request(app.getHttpServer() as Server)
      .get('/api/v1/search')
      .query({ q })
      .set('Authorization', `Bearer ${token}`);

  const sectionOf = (body: SearchBody, type: string) => body.sections.find((s) => s.type === type);

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder', 'sys_admin']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const boss = await mkUser(uniqueUsername('gs_boss'), 'boss');
    bossToken = boss.token;
    bossId = boss.id;
    const sales = await mkUser(uniqueUsername('gs_sales'), 'sales_ops');
    salesToken = sales.token;
    salesId = sales.id;
    sales2Id = (await mkUser(uniqueUsername('gs_sales2'), 'sales_ops')).id;
    recorderToken = (await mkUser(uniqueUsername('gs_recorder'), 'recorder')).token;
    sysAdminToken = (await mkUser(uniqueUsername('gs_sysadmin'), 'sys_admin')).token;

    // —— tag：boss 四节各命中 1 条 ——
    lead1 = await prisma.lead.create({
      data: {
        leadNo: `L-GS-${tag}-0001`,
        sourceCategory: 'online',
        sourcePlatform: `渠道-${tag}`,
        customerName: `张三${tag}`,
        target: 'Model Y',
        stage: 'communicating',
        ownerUserId: sales2Id,
        // PII：手机号仅落库，不参与搜索（下方反证）
        phone: `139${tag}8888`,
      },
    });
    k1 = await prisma.knowledgeItem.create({
      data: {
        kind: 'product',
        key: `product-gs-${tag}`,
        title: `演示品牌DM03产品手册${tag}`,
        content: '全车隔热膜施工要点',
        status: 'active',
        createdBy: bossId,
      },
    });
    appt1 = await prisma.appointment.create({
      data: {
        customerId: 'cust_gs_test',
        serviceItem: `DM10隔热膜${tag}`,
        workbench: `${tag}A1`,
        startAt: new Date(),
        status: 'pending',
        createdBy: sales2Id,
      },
    });
    // 已取消预约：即使 serviceItem 匹配也应被排除（M07 口径）
    await prisma.appointment.create({
      data: {
        customerId: 'cust_gs_test',
        serviceItem: `G5隔热膜${tag}`,
        workbench: `${tag}A9`,
        startAt: new Date(),
        status: 'cancelled',
        createdBy: sales2Id,
      },
    });
    wo1 = await prisma.workOrder.create({
      data: {
        orderNo: `W-GS-${tag}-0001`,
        leadId: lead1.id,
        serviceItem: `DM10隔热膜${tag}`,
        stage: 'in_progress',
      },
    });

    // —— tag2：sales 本人/他人范围 ——
    leadOwn = await prisma.lead.create({
      data: {
        leadNo: `L-GS-${tag2}-OWN`,
        sourceCategory: 'online',
        sourcePlatform: `渠道-${tag2}`,
        customerName: `李四${tag2}`,
        stage: 'new',
        ownerUserId: salesId,
      },
    });
    leadOther = await prisma.lead.create({
      data: {
        leadNo: `L-GS-${tag2}-OTH`,
        sourceCategory: 'online',
        sourcePlatform: `渠道-${tag2}`,
        customerName: `王五${tag2}`,
        stage: 'new',
        ownerUserId: sales2Id,
      },
    });
    // 知识 tag 只进 content：验证 title/content 双字段匹配
    await prisma.knowledgeItem.create({
      data: {
        kind: 'brand',
        key: `brand-gs-${tag2}`,
        title: '驾驶注意事项',
        content: `含${tag2}的补充说明`,
        status: 'draft',
        createdBy: bossId,
      },
    });
    apptOwn = await prisma.appointment.create({
      data: {
        customerId: 'cust_gs_test',
        serviceItem: `DM26隔热膜${tag2}`,
        workbench: `${tag2}B1`,
        startAt: new Date(),
        status: 'pending',
        createdBy: salesId,
      },
    });
    apptOther = await prisma.appointment.create({
      data: {
        customerId: 'cust_gs_test',
        serviceItem: `G5隔热膜${tag2}`,
        workbench: `${tag2}B2`,
        startAt: new Date(),
        status: 'pending',
        createdBy: sales2Id,
      },
    });
    woOwn = await prisma.workOrder.create({
      data: { orderNo: `W-GS-${tag2}-OWN`, leadId: leadOwn.id, stage: 'pending' },
    });
    woOther = await prisma.workOrder.create({
      data: { orderNo: `W-GS-${tag2}-OTH`, leadId: leadOther.id, stage: 'pending' },
    });

    // —— tag3：素材节（V2.3b）——
    asset1 = await prisma.asset.create({
      data: {
        kind: 'finished',
        title: `卡宴完工案例${tag3}`,
        filePath: `uploads/assets/asset-${tag3}-test.png`,
        carModel: `Cayenne${tag3}`,
        licensed: false,
        createdBy: bossId,
      },
    });

    // —— tag4：命中片段/关联度排序（2026-08-21）——关键词「居家膜{tag4}」——
    // kTitle 标题命中（最后创建：验证关联度排序压过 updatedAt 倒序），其余只进 content
    kTitle = await prisma.knowledgeItem.create({
      data: {
        kind: 'product',
        key: `product-gs-${tag4}`,
        title: `居家膜${tag4}导购速览`,
        content: '按预算与隐私需求选系列',
        status: 'active',
        createdBy: bossId,
      },
    });
    await prisma.knowledgeItem.create({
      data: {
        kind: 'price',
        key: `price-gs-${tag4}`,
        title: `价格速查${tag4}`,
        content: `客户问价时居家膜${tag4}套餐按一口价报，不做议价`,
        status: 'active',
        createdBy: bossId,
      },
    });
    await prisma.knowledgeItem.create({
      data: {
        kind: 'warranty',
        key: `warranty-gs-${tag4}`,
        title: `质保范围${tag4}`,
        content: `居家膜${tag4}质保年限八年起，官方渠道可查`,
        status: 'active',
        createdBy: bossId,
      },
    });
  });

  afterAll(async () => {
    // 按本次运行 tag 清理（不碰跨运行残留）
    for (const t of [tag, tag2, tag3, tag4]) {
      await prisma.asset.deleteMany({ where: { title: { contains: t } } });
      await prisma.workOrder.deleteMany({ where: { orderNo: { contains: `W-GS-${t}` } } });
      await prisma.appointment.deleteMany({
        where: { OR: [{ serviceItem: { contains: t } }, { workbench: { contains: t } }] },
      });
      await prisma.knowledgeItem.deleteMany({ where: { title: { contains: t } } });
      await prisma.lead.deleteMany({ where: { leadNo: { contains: `L-GS-${t}` } } });
    }
    await app.close();
  });

  it('boss：四节各命中 1 条且 link 正确', async () => {
    const res = await search(bossToken, tag).expect(200);
    const body = res.body as SearchBody;
    expect(body.q).toBe(tag);
    expect(body.sections.map((s) => s.type).sort()).toEqual(
      ['appointments', 'knowledge', 'leads', 'workOrders'].sort(),
    );

    const leads = sectionOf(body, 'leads')!;
    expect(leads.items.map((i) => i.id)).toEqual([lead1.id]);
    expect(leads.items[0].link).toBe(`/leads/${lead1.id}`);
    expect(leads.items[0].title).toContain(`张三${tag}`);
    expect(leads.items[0].sub).toContain(`L-GS-${tag}-0001`);

    const knowledge = sectionOf(body, 'knowledge')!;
    expect(knowledge.items.map((i) => i.id)).toEqual([k1.id]);
    expect(knowledge.items[0].link).toBe('/knowledge');
    expect(knowledge.items[0].sub).toContain('active'); // 全状态可搜且状态随行

    const appts = sectionOf(body, 'appointments')!;
    expect(appts.items.map((i) => i.id)).toEqual([appt1.id]); // 已取消预约被排除
    expect(appts.items[0].link).toBe('/appointments');
    expect(appts.items[0].title).toContain(`DM10隔热膜${tag}`);

    const wos = sectionOf(body, 'workOrders')!;
    expect(wos.items.map((i) => i.id)).toEqual([wo1.id]);
    expect(wos.items[0].link).toBe('/work-orders');
    expect(wos.items[0].title).toContain(`W-GS-${tag}-0001`);
  });

  it('sales：仅本人客资/预约/施工单可见，knowledge 全量', async () => {
    const res = await search(salesToken, tag2).expect(200);
    const body = res.body as SearchBody;

    // 他人客资（ownerUserId=sales2）不可见
    const leadIds = sectionOf(body, 'leads')!.items.map((i) => i.id);
    expect(leadIds).toEqual([leadOwn.id]);
    expect(leadIds).not.toContain(leadOther.id);
    // 他人创建的预约（createdBy=sales2）不可见
    const apptIds = sectionOf(body, 'appointments')!.items.map((i) => i.id);
    expect(apptIds).toEqual([apptOwn.id]);
    expect(apptIds).not.toContain(apptOther.id);
    // 他人客资关联的施工单（leadId∉本人 leads）不可见
    const woIds = sectionOf(body, 'workOrders')!.items.map((i) => i.id);
    expect(woIds).toEqual([woOwn.id]);
    expect(woIds).not.toContain(woOther.id);
    // knowledge 节在：tag2 只出现在 content，验证 content 匹配 + 销售全量可见
    const knowledge = sectionOf(body, 'knowledge')!;
    expect(knowledge).toBeDefined();
    expect(knowledge.items.length).toBe(1);
    expect(knowledge.items[0].title).toBe('驾驶注意事项');
  });

  it('recorder：仅 knowledge+workOrders 节，无 leads/appointments 节', async () => {
    const res = await search(recorderToken, tag).expect(200);
    const body = res.body as SearchBody;
    const types = body.sections.map((s) => s.type);
    expect(types).toContain('knowledge');
    expect(types).toContain('workOrders');
    expect(types).not.toContain('leads');
    expect(types).not.toContain('appointments');
    // recorder 对可见节为全局视野（M08 先例）
    expect(sectionOf(body, 'knowledge')!.items.map((i) => i.id)).toEqual([k1.id]);
    expect(sectionOf(body, 'workOrders')!.items.map((i) => i.id)).toEqual([wo1.id]);
  });

  it('sys_admin：业务角色无分节，返回空 sections（非 403）', async () => {
    const res = await search(sysAdminToken, tag).expect(200);
    expect((res.body as SearchBody).sections).toEqual([]);
  });

  it('参数校验：q 单字 422、q 缺失 422', async () => {
    await search(bossToken, '张').expect(422);
    await request(app.getHttpServer() as Server)
      .get('/api/v1/search')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(422);
  });

  it('PII 边界：手机号不参与搜索（搜号码片段无命中）', async () => {
    const res = await search(bossToken, `139${tag}`).expect(200);
    expect((res.body as SearchBody).sections).toEqual([]);
  });

  it('素材节（V2.3b）：recorder 可见 assets 节，title/carModel ILIKE 命中且对内不限制 licensed', async () => {
    // title 匹配
    const byTitle = await search(recorderToken, `卡宴完工案例${tag3}`).expect(200);
    const body = byTitle.body as SearchBody;
    const types = body.sections.map((s) => s.type);
    expect(types).toContain('assets');
    expect(types).not.toContain('leads'); // recorder 无 m03/m07，仍不见客资/预约
    const assets = sectionOf(body, 'assets')!;
    expect(assets.items.map((i) => i.id)).toEqual([asset1.id]);
    expect(assets.items[0].link).toBe('/assets');
    expect(assets.items[0].title).toBe(`卡宴完工案例${tag3}`);
    // carModel 匹配（title 不含该片段）
    const byCar = await search(recorderToken, `Cayenne${tag3}`).expect(200);
    const carAssets = sectionOf(byCar.body as SearchBody, 'assets')!;
    expect(carAssets.items.map((i) => i.id)).toEqual([asset1.id]);
  });

  it('命中片段与关联度排序（2026-08-21）：标题命中排最前，content 命中带片段', async () => {
    const res = await search(bossToken, `居家膜${tag4}`).expect(200);
    const body = res.body as SearchBody;
    const knowledge = sectionOf(body, 'knowledge')!;
    expect(knowledge.items).toHaveLength(3);
    // 关联度排序：kTitle 最后创建（updatedAt 最新）但标题命中——必须排第一（压过时间序）
    expect(knowledge.items[0].id).toBe(kTitle.id);
    // content 命中的两条：snippet 非空且包含完整关键词，排在标题命中之后
    for (const item of knowledge.items.slice(1)) {
      expect(item.snippet).toContain(`居家膜${tag4}`);
    }
  });
});
