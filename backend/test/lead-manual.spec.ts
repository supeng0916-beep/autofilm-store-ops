import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface LeadBody {
  id: string;
  leadNo: string;
  stage: string;
  sourceCategory: string;
  sourcePlatform: string;
  ownerUserId: string | null;
  dupOfLeadId: string | null;
  batchId: string | null;
  phone: string | null;
}

interface DupCheckBody {
  duplicate: boolean;
  lead?: { id: string; leadNo: string; customerName: string | null };
}

/** 手工登记客资（POST /leads + GET /leads/dup-check，2026-08-25 老板需求）：
 * 字段口径=字典 17 列导入子集；与导入同权复用查重挂链/分派路由/摘要触发。 */
describe('手工登记客资', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  const tag = Math.random().toString(36).slice(2, 8);
  // 本轮唯一电话/微信（测试库跨轮残留隔离；dedup 按归一化字符串精确命中）
  const phone = `139${tag
    .split('')
    .map((c) => String(c.charCodeAt(0) % 10))
    .join('')
    .padEnd(8, '0')}`;
  const wechat = `wx-${tag}`;
  let salesToken = '';
  let salesId = '';
  let recorderToken = '';

  const api = (method: 'get' | 'post' | 'patch' | 'delete', url: string, token?: string) => {
    const req = request(app.getHttpServer() as Server)[method](url);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

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

  const body = (over: Record<string, unknown> = {}) => ({
    sourceCategory: 'online',
    sourcePlatform: '抖音',
    customerName: `手工客${tag}`,
    phone,
    wechatType: 'real',
    businessType: 'auto_film',
    target: 'Model Y',
    productNeed: '全车隔热膜',
    rawNeed: '刷到视频私信问价',
    ...over,
  });

  beforeAll(async () => {
    app = await buildApp();
    // 停掉定时任务（沉默/SLA 扫描等），用例不赌定时器（asset.e2e 同手法）
    const registry = app.get(SchedulerRegistry);
    for (const job of registry.getCronJobs().values()) void job.stop();
    for (const name of registry.getIntervals()) {
      clearInterval(registry.getInterval(name) as NodeJS.Timeout);
    }
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const sales = await mkUser(uniqueUsername('lm_sales'), 'sales_ops');
    salesToken = sales.token;
    salesId = sales.id;
    recorderToken = (await mkUser(uniqueUsername('lm_rec'), 'recorder')).token;
  });

  afterAll(async () => {
    const leads = await prisma.lead.findMany({
      where: { OR: [{ phone }, { wechat }, { customerName: { contains: tag } }] },
      select: { id: true, customerId: true },
    });
    await prisma.lead.deleteMany({ where: { id: { in: leads.map((l) => l.id) } } });
    await prisma.customer.deleteMany({
      where: { id: { in: leads.map((l) => l.customerId).filter((x): x is string => !!x) } },
    });
    await prisma.user.deleteMany({ where: { username: { contains: 'lm_' } } });
    await app.close();
  });

  it('登记成功（默认自动路由）：建 Lead+双事件、无导入批次、leadNo 规范', async () => {
    const res = await api('post', '/api/v1/leads', salesToken).send(body()).expect(201);
    const created = res.body as LeadBody;
    expect(created.leadNo).toMatch(/^L-\d{8}-\d{4}$/);
    expect(created.stage).toBe('new');
    expect(created.sourceCategory).toBe('online');
    expect(created.batchId).toBeNull(); // 手工登记无导入批次
    // 事件：manual_registered 必有；assigned 必有（路由命中或兜底事件）
    const kinds = await prisma.leadEvent.findMany({
      where: { leadId: created.id },
      select: { kind: true },
    });
    const kindList = kinds.map((k) => k.kind);
    expect(kindList).toContain('manual_registered');
    expect(kindList).toContain('assigned');
  });

  it('指定负责人：直接落 owner 并留痕；负责人不存在 404', async () => {
    const res = await api('post', '/api/v1/leads', salesToken)
      .send(body({ phone: `${phone}01`, ownerUserId: salesId }))
      .expect(201);
    const created = res.body as LeadBody;
    expect(created.ownerUserId).toBe(salesId);
    const events = await prisma.leadEvent.findMany({
      where: { leadId: created.id, kind: 'assigned' },
    });
    const reasons = events.map((e) => (e.content as { reason?: string } | null)?.reason);
    expect(reasons).toContain('手工登记指定负责人');

    await api('post', '/api/v1/leads', salesToken)
      .send(body({ phone: `${phone}02`, ownerUserId: 'nonexistent-user' }))
      .expect(404);
  });

  it('实时查重：命中返回主客资概要、未命中 false、无参拒绝', async () => {
    const hit = await api('get', `/api/v1/leads/dup-check?phone=${phone}`, salesToken).expect(200);
    const hitBody = hit.body as DupCheckBody;
    expect(hitBody.duplicate).toBe(true);
    expect(hitBody.lead?.leadNo).toMatch(/^L-/);
    // 微信命中
    await api('post', '/api/v1/leads', salesToken)
      .send(body({ phone: undefined, wechat }))
      .expect(201);
    const wxHit = await api('get', `/api/v1/leads/dup-check?wechat=${wechat}`, salesToken).expect(
      200,
    );
    expect((wxHit.body as DupCheckBody).duplicate).toBe(true);
    // 未命中
    const miss = await api('get', `/api/v1/leads/dup-check?phone=13700009999`, salesToken).expect(
      200,
    );
    expect((miss.body as DupCheckBody).duplicate).toBe(false);
    // 无参 → 拒绝（400/422 视校验层映射）
    const empty = await api('get', '/api/v1/leads/dup-check', salesToken);
    expect([400, 422]).toContain(empty.status);
  });

  it('重复登记挂链：同电话再次登记 dupOfLeadId 指向主客资且写 dup_linked 事件', async () => {
    const again = await api('post', '/api/v1/leads', salesToken)
      .send(body({ customerName: `手工客重复${tag}` }))
      .expect(201);
    const dup = again.body as LeadBody;
    expect(dup.dupOfLeadId).not.toBeNull();
    const ev = await prisma.leadEvent.findFirst({
      where: { leadId: dup.id, kind: 'dup_linked' },
    });
    expect(ev).not.toBeNull();
  });

  it('校验：电话微信全无/缺来源平台/非法枚举 拒绝', async () => {
    const noContact = await api('post', '/api/v1/leads', salesToken).send(
      body({ phone: undefined }),
    );
    expect([400, 422]).toContain(noContact.status);
    const noPlatform = await api('post', '/api/v1/leads', salesToken).send(
      body({ phone: `${phone}03`, sourcePlatform: '' }),
    );
    expect([400, 422]).toContain(noPlatform.status);
    const badEnum = await api('post', '/api/v1/leads', salesToken).send(
      body({ phone: `${phone}04`, sourceCategory: 'unknown' }),
    );
    expect([400, 422]).toContain(badEnum.status);
    // 以上均未落库（只数本用例的 03/04 两个载荷，不含前序用例的合法客资）
    const count = await prisma.lead.count({
      where: { phone: { in: [`${phone}03`, `${phone}04`] } },
    });
    expect(count).toBe(0);
  });

  it('可指定负责人清单不含 ph- 占位账号（2026-08-28 bug5）', async () => {
    const res = await api('get', '/api/v1/leads/assignable-users', salesToken).expect(200);
    const users = res.body as Array<{ username: string }>;
    expect(users.some((u) => u.username.startsWith('ph-'))).toBe(false);
  });

  it('可指定负责人清单：仅返回在职 boss/店长/销售，含本套件 sales 用户', async () => {
    const res = await api('get', '/api/v1/leads/assignable-users', salesToken).expect(200);
    const users = res.body as Array<{ id: string; username: string; displayName: string }>;
    expect(users.some((u) => u.id === salesId)).toBe(true);
    // recorder 用户不在清单（无销售位角色）
    const recorder = await prisma.user.findFirst({
      where: { username: { contains: 'lm_rec' } },
    });
    expect(recorder).not.toBeNull();
    expect(users.some((u) => u.id === recorder!.id)).toBe(false);
    // 无 m03 权限 → 403
    await api('get', '/api/v1/leads/assignable-users', recorderToken).expect(403);
  });

  it('权限：recorder（无 m03 权限）登记与查重均 403', async () => {
    await api('post', '/api/v1/leads', recorderToken)
      .send(body({ phone: `${phone}05` }))
      .expect(403);
    await api('get', `/api/v1/leads/dup-check?phone=${phone}`, recorderToken).expect(403);
  });
});
