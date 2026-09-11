import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import { LeadImportService } from '../src/modules/lead/lead-import.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { uniqueUsername } from './helpers/unique';
import { buildApp } from './setup';

/** 模板 17 列表头（与 import/row-schema.ts HEADER_MAP 列序一致） */
const HEADERS = [
  '来源大类',
  '来源平台',
  '运营主体',
  '获客方式',
  '上游派发NO/介绍人',
  '广告计划/活动原文',
  '内容标题/内容ID/链接',
  '上游聊天/原始信息链接',
  '客户称呼',
  '联系电话',
  '微信号',
  '微信号类型',
  '业务类型',
  '车型/住宅对象',
  '需求产品/服务',
  '客户原始需求',
  '备注',
];

interface PreviewBody {
  previewToken: string;
}
interface ConfirmBody {
  batchId: string;
  created: number;
  dupCount: number;
}
interface DispatchBody {
  batchId: string;
  created: number;
  dupCount: number;
}
interface ErrorBody {
  code: string;
}

let phoneSeq = 0;
/** 合成 138 段电话（唯一，避免跨测试/跨运行撞号）：138 + 时间戳后 7 位 + 序号 1 位 */
function syntheticPhone(): string {
  const ts = String(Date.now()).slice(-7);
  const seq = String(phoneSeq++ % 10);
  return `138${ts}${seq}`;
}

/** 归一化展示：13824680278 → +86 138-1234-5678（normalize 后与原号等价） */
function formatPhone(p: string): string {
  return `+86 ${p.slice(0, 3)}-${p.slice(3, 7)}-${p.slice(7)}`;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function toCsv(rows: string[][]): string {
  return [HEADERS, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}
/** 单行合法客资（phone 为唯一身份；remark 变动以区分两次导入的文件指纹） */
function validRow(phone: string, remark = '测试备注'): string[] {
  return [
    '线上',
    '抖音',
    '品牌总部代运营',
    '广告私信',
    'D-1001',
    'AutoFilm Demo-测试素材',
    'content-1',
    'https://chat.example.com/1',
    '客户甲',
    phone,
    '',
    'real',
    'auto_film',
    '凯迪拉克XT5',
    '改色膜',
    '想贴改色膜',
    remark,
  ];
}

function dispatchText(phone: string, dispatchNo: string): string {
  return [
    `派发NO：${dispatchNo}`,
    '门店：AutoFilm Demo',
    '日期：2026-08-14 10:20',
    '信息来源：抖音私信',
    `电话：${phone}`,
    '车型：凯迪拉克XT5',
    '需求：隐形车衣',
  ].join('\n');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await sleep(5);
  }
}

describe('P3-02 去重与合并', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let auth: AuthService;
  let importService: LeadImportService;
  let bossToken = '';
  let recorderToken = '';
  const password = 'S3cure-Passw0rd!';

  const mkUser = async (uname: string, role: string): Promise<{ token: string }> => {
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
    return { token: (res.body as { accessToken: string }).accessToken };
  };

  /** CSV 两阶段导入并确认，返回 { created, dupCount } */
  const importCsv = async (rows: string[][]): Promise<{ created: number; dupCount: number }> => {
    const preview = await request(server)
      .post('/api/v1/leads/import/preview')
      .set('Authorization', `Bearer ${bossToken}`)
      .attach('file', Buffer.from(toCsv(rows)), { filename: 'leads.csv', contentType: 'text/csv' });
    expect(preview.status).toBe(200);
    const token = (preview.body as PreviewBody).previewToken;
    const confirm = await request(server)
      .post('/api/v1/leads/import/confirm')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ previewToken: token });
    expect(confirm.status).toBe(200);
    const body = confirm.body as ConfirmBody;
    return { created: body.created, dupCount: body.dupCount };
  };

  beforeAll(async () => {
    app = await buildApp();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    importService = app.get(LeadImportService);
    for (const code of ['boss', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    bossToken = (await mkUser(uniqueUsername('dedup_boss'), 'boss')).token;
    recorderToken = (await mkUser(uniqueUsername('dedup_recorder'), 'recorder')).token;
  });

  afterAll(async () => {
    await app.close();
  });

  it('同电话二次导入：新 Lead 创建但 dupOfLeadId 指向首条，客户不重复新建', async () => {
    const phone = syntheticPhone();
    const first = await importCsv([validRow(phone, '首次')]);
    expect(first.created).toBe(1);
    expect(first.dupCount).toBe(0);

    const second = await importCsv([validRow(phone, '二次')]);
    expect(second.created).toBe(1);
    expect(second.dupCount).toBe(1);

    const leads = await prisma.lead.findMany({
      where: { phone },
      orderBy: { createdAt: 'asc' },
    });
    expect(leads).toHaveLength(2);
    const [primary, dup] = leads;
    expect(primary.dupOfLeadId).toBeNull();
    expect(dup.dupOfLeadId).toBe(primary.id);

    // 客户不重复新建：该电话只落一条 Customer，且两条 Lead 指向同一 customer
    const customers = await prisma.customer.findMany({ where: { phone } });
    expect(customers).toHaveLength(1);
    expect(primary.customerId).toBe(customers[0].id);
    expect(dup.customerId).toBe(customers[0].id);
  });

  it('归一化命中：+86 138-xxxx-xxxx 与 138xxxxxxxx 视为同一联系方式', async () => {
    const base = syntheticPhone();
    const formatted = formatPhone(base);

    const first = await importCsv([validRow(formatted, '归一化首')]);
    expect(first.created).toBe(1);
    const second = await importCsv([validRow(base, '归一化次')]);
    expect(second.created).toBe(1);
    expect(second.dupCount).toBe(1);

    const leadA = await prisma.lead.findFirst({ where: { phone: formatted } });
    const leadB = await prisma.lead.findFirst({ where: { phone: base } });
    expect(leadA).not.toBeNull();
    expect(leadB).not.toBeNull();
    expect(leadB!.dupOfLeadId).toBe(leadA!.id);
    expect(leadB!.customerId).toBe(leadA!.customerId);
    expect(leadA!.customerId).not.toBeNull();
  });

  it('连续相同联系方式派发 3 次 → 3 条 Lead 全在，事件链完整可回放', async () => {
    const phone = syntheticPhone();
    for (let i = 0; i < 3; i++) {
      const res = await request(server)
        .post('/api/v1/leads/import/dispatch')
        .set('Authorization', `Bearer ${bossToken}`)
        .send({ rawTexts: [dispatchText(phone, `D-${Date.now()}-${i}`)] });
      expect(res.status).toBe(200);
      expect((res.body as DispatchBody).created).toBe(1);
      expect((res.body as DispatchBody).dupCount).toBe(i === 0 ? 0 : 1);
    }

    const leads = await prisma.lead.findMany({
      where: { phone },
      orderBy: { createdAt: 'asc' },
    });
    expect(leads).toHaveLength(3);
    const [primary, d2, d3] = leads;
    expect(primary.dupOfLeadId).toBeNull();
    expect(d2.dupOfLeadId).toBe(primary.id);
    expect(d3.dupOfLeadId).toBe(primary.id);

    // 事件链完整：每条 Lead 均有派发解析事件；重复两条另有 dup_linked 指向主客资
    for (const lead of leads) {
      const events = await prisma.leadEvent.findMany({ where: { leadId: lead.id } });
      expect(events.some((e) => e.kind === 'dispatch_parsed')).toBe(true);
    }
    for (const dup of [d2, d3]) {
      const dupEvent = await prisma.leadEvent.findFirst({
        where: { leadId: dup.id, kind: 'dup_linked' },
      });
      expect(dupEvent).not.toBeNull();
      expect((dupEvent!.content as { primaryLeadId?: string }).primaryLeadId).toBe(primary.id);
    }
  });

  it('T5 复购兜底：主客资已 won，同联系方式新客资仍挂链并沿用既有 customerId', async () => {
    const phone = syntheticPhone();
    // 已成交主客资：带既有 Customer（复购统计按 customerId 分桶的锚点）
    const customer = await prisma.customer.create({ data: { name: '复购客户', phone } });
    const won = await prisma.lead.create({
      data: {
        leadNo: `L-${randomUUID().replaceAll('-', '')}`,
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        phone,
        customerName: '复购客户',
        finalStatus: 'won',
        customerId: customer.id,
      },
    });

    const res = await importCsv([validRow(phone, '复购回访')]);
    expect(res.created).toBe(1);
    expect(res.dupCount).toBe(1);

    // 新客资挂链 won 主客资，customerId 沿用既有 Customer（不新建）
    const newLead = await prisma.lead.findFirst({ where: { phone, dupOfLeadId: won.id } });
    expect(newLead).not.toBeNull();
    expect(newLead!.customerId).toBe(customer.id);
    const customers = await prisma.customer.findMany({ where: { phone } });
    expect(customers).toHaveLength(1);
  });

  it('T5 active 优先：同联系方式 active 与 won 并存时挂 active 主客资（状态优先于时间）', async () => {
    const phone = syntheticPhone();
    // won 更早、active 更晚：两级匹配先查 active，不按 createdAt 先后选 won
    const won = await prisma.lead.create({
      data: {
        leadNo: `L-${randomUUID().replaceAll('-', '')}`,
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        phone,
        customerName: '早先成交',
        finalStatus: 'won',
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    const active = await prisma.lead.create({
      data: {
        leadNo: `L-${randomUUID().replaceAll('-', '')}`,
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        phone,
        customerName: '当前在跟',
        finalStatus: 'active',
      },
    });
    expect(won.createdAt.getTime()).toBeLessThan(active.createdAt.getTime());

    const res = await importCsv([validRow(phone, '优先级')]);
    expect(res.created).toBe(1);
    expect(res.dupCount).toBe(1);

    const newLead = await prisma.lead.findFirst({ where: { phone, dupOfLeadId: { not: null } } });
    expect(newLead).not.toBeNull();
    expect(newLead!.dupOfLeadId).toBe(active.id);
  });

  it('T5 lost 兜底：主客资已 lost（战败），同联系方式新客资同样挂链', async () => {
    const phone = syntheticPhone();
    const customer = await prisma.customer.create({ data: { name: '战败客户', phone } });
    const lost = await prisma.lead.create({
      data: {
        leadNo: `L-${randomUUID().replaceAll('-', '')}`,
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        phone,
        customerName: '战败客户',
        finalStatus: 'lost',
        customerId: customer.id,
      },
    });

    const res = await importCsv([validRow(phone, '战败回访')]);
    expect(res.created).toBe(1);
    expect(res.dupCount).toBe(1);

    const newLead = await prisma.lead.findFirst({ where: { phone, dupOfLeadId: lost.id } });
    expect(newLead).not.toBeNull();
    expect(newLead!.customerId).toBe(customer.id);
  });

  it('人工合并写 merged 事件与审计，原记录不删除', async () => {
    const leadA = await prisma.lead.create({
      data: {
        leadNo: `L-${randomUUID().replaceAll('-', '')}`,
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        phone: syntheticPhone(),
        customerName: '主客户',
      },
    });
    const leadB = await prisma.lead.create({
      data: {
        leadNo: `L-${randomUUID().replaceAll('-', '')}`,
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        phone: syntheticPhone(),
        customerName: '次客户',
      },
    });

    const res = await request(server)
      .post(`/api/v1/leads/${leadA.id}/merge`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ targetLeadId: leadB.id });
    expect(res.status).toBe(200);

    // 原记录不删除：两条 Lead 仍在
    const afterA = await prisma.lead.findUnique({ where: { id: leadA.id } });
    const afterB = await prisma.lead.findUnique({ where: { id: leadB.id } });
    expect(afterA).not.toBeNull();
    expect(afterB).not.toBeNull();
    expect(afterB!.dupOfLeadId).toBe(leadA.id);
    expect(afterA!.customerId).not.toBeNull();
    expect(afterB!.customerId).toBe(afterA!.customerId);

    // merged 事件 ×2
    const mergeA = await prisma.leadEvent.findFirst({
      where: { leadId: leadA.id, kind: 'merged' },
    });
    const mergeB = await prisma.leadEvent.findFirst({
      where: { leadId: leadB.id, kind: 'merged' },
    });
    expect(mergeA).not.toBeNull();
    expect((mergeA!.content as { mergedLeadId?: string }).mergedLeadId).toBe(leadB.id);
    expect(mergeB).not.toBeNull();
    expect((mergeB!.content as { primaryLeadId?: string }).primaryLeadId).toBe(leadA.id);

    // 审计留痕
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'lead.merge', objectType: 'lead', objectId: leadA.id },
    });
    expect(audit).not.toBeNull();
  });

  it('并发同联系方式导入互斥：恰一条主 Lead、其余挂链、Customer 不重复', async () => {
    const phone = syntheticPhone();
    let entered = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    importService.onCriticalSectionEnter = () => {
      entered += 1;
      return entered === 1 ? firstGate : undefined;
    };

    try {
      const N = 3;
      // 并发发起 N 次同联系方式导入
      const pending = Array.from({ length: N }, (_, i) => importCsv([validRow(phone, `并发${i}`)]));
      // 首个请求进入临界区被屏障阻塞；其余应被互斥锁挡在临界区外（entered 仍为 1）
      await waitFor(() => entered >= 1);
      await sleep(50);
      expect(entered).toBe(1);
      releaseFirst();

      const results = await Promise.all(pending);
      expect(results.map((r) => r.created)).toEqual(Array(N).fill(1));

      const leads = await prisma.lead.findMany({ where: { phone }, orderBy: { createdAt: 'asc' } });
      expect(leads).toHaveLength(N);
      const primaries = leads.filter((l) => l.dupOfLeadId === null);
      expect(primaries).toHaveLength(1);
      const primary = primaries[0];
      for (const l of leads) {
        if (l.id !== primary.id) expect(l.dupOfLeadId).toBe(primary.id);
      }
      // Customer 不重复：该电话只落一条 Customer，且所有 Lead 指向同一 customer
      const customers = await prisma.customer.findMany({ where: { phone } });
      expect(customers).toHaveLength(1);
      for (const l of leads) expect(l.customerId).toBe(customers[0].id);
    } finally {
      importService.onCriticalSectionEnter = undefined;
    }
  });

  it('无 m03:edit 权限调合并被拒 403', async () => {
    const leadA = await prisma.lead.create({
      data: {
        leadNo: `L-${randomUUID().replaceAll('-', '')}`,
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        phone: syntheticPhone(),
      },
    });
    const leadB = await prisma.lead.create({
      data: {
        leadNo: `L-${randomUUID().replaceAll('-', '')}`,
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        phone: syntheticPhone(),
      },
    });

    const res = await request(server)
      .post(`/api/v1/leads/${leadA.id}/merge`)
      .set('Authorization', `Bearer ${recorderToken}`)
      .send({ targetLeadId: leadB.id });
    expect(res.status).toBe(403);
    expect((res.body as ErrorBody).code).toBe('PERM_DENIED');
  });
});
