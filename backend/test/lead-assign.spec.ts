import { INestApplication, Logger } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import {
  AssignService,
  ASSIGN_META_KEYS,
  routeLead,
  type RouteContext,
  type RouteLeadInput,
} from '../src/modules/lead/assign.service';
import { LeadImportService } from '../src/modules/lead/lead-import.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

/** 纯函数测试用 ctx：池 username↔userId 双向映射固定 */
function makeCtx(overrides: Partial<RouteContext> = {}): RouteContext {
  const userIdByUsername = new Map<string, string>([
    ['boss', 'u0'],
    ['zhenjie', 'u1'],
    ['ajing', 'u2'],
    ['amei', 'u3'],
    ['abing', 'u4'],
  ]);
  const usernameByUserId = new Map<string, string>([
    ['u0', 'boss'],
    ['u1', 'zhenjie'],
    ['u2', 'ajing'],
    ['u3', 'amei'],
    ['u4', 'abing'],
  ]);
  return {
    onlinePool: ['zhenjie', 'ajing', 'amei'],
    fourSPool: ['abing'],
    bossUsername: 'boss',
    cursor: 0,
    activeCount: new Map(),
    disabled: new Set(),
    maxActive: 30,
    userIdByUsername,
    usernameByUserId,
    ...overrides,
  };
}

function onlineInput(overrides: Partial<RouteLeadInput> = {}): RouteLeadInput {
  return { sourcePlatform: '抖音', ...overrides };
}

describe('routeLead 纯函数（P3-03 路由矩阵）', () => {
  it('线上普通客资在负责人乙/销售甲/销售乙池轮询：连续 6 条平均分配', () => {
    const owners: (string | null)[] = [];
    for (let cursor = 0; cursor < 6; cursor++) {
      const d = routeLead(onlineInput(), makeCtx({ cursor }));
      owners.push(d.ownerUserId);
      expect(d.reason).toContain('线上池');
      expect(d.fromPool).toBe(true);
    }
    expect(owners).toEqual(['u1', 'u2', 'u3', 'u1', 'u2', 'u3']);
  });

  it('重复客资沿用主 Lead 负责人，不参与轮询', () => {
    const d = routeLead(onlineInput({ dupOfLeadId: 'primary-1', dupOwnerUserId: 'u2' }), makeCtx());
    expect(d.ownerUserId).toBe('u2');
    expect(d.reason).toBe('重复客资沿用原负责人');
    expect(d.fromPool).toBe(false);
  });

  it('重复负责人已 disabled 时落入轮询分支', () => {
    const d = routeLead(
      onlineInput({ dupOfLeadId: 'primary-1', dupOwnerUserId: 'u2' }),
      makeCtx({ disabled: new Set(['ajing']) }),
    );
    expect(d.ownerUserId).toBe('u1'); // cursor 0 → 负责人乙
    expect(d.reason).toContain('线上池');
  });

  it('转介绍回原关系维护人', () => {
    const d = routeLead(onlineInput({ referralOwnerUserId: 'u3' }), makeCtx());
    expect(d.ownerUserId).toBe('u3');
    expect(d.reason).toBe('转介绍回原关系维护人');
  });

  it('转介绍维护人已 disabled 时落入轮询分支', () => {
    const d = routeLead(
      onlineInput({ referralOwnerUserId: 'u3' }),
      makeCtx({ disabled: new Set(['amei']) }),
    );
    expect(d.ownerUserId).toBe('u1');
    expect(d.reason).toContain('线上池');
  });

  it('到店（sourcePlatform 含「到店」或 acquisitionMethod=到店）不自动分配', () => {
    expect(routeLead(onlineInput({ sourcePlatform: '到店' }), makeCtx()).ownerUserId).toBeNull();
    expect(routeLead(onlineInput({ acquisitionMethod: '到店' }), makeCtx()).ownerUserId).toBeNull();
    const d = routeLead(onlineInput({ sourcePlatform: '到店' }), makeCtx());
    expect(d.reason).toBe('到店客资待接待人手工认领');
  });

  it('4S 线索给店长池（店长甲）', () => {
    const d = routeLead(onlineInput({ sourcePlatform: '4S店' }), makeCtx());
    expect(d.ownerUserId).toBe('u4');
    expect(d.reason).toContain('4S池');
  });

  it('店长达在跟上限时兜底老板', () => {
    const d = routeLead(
      onlineInput({ sourcePlatform: '4S店' }),
      makeCtx({ activeCount: new Map([['abing', 30]]) }),
    );
    expect(d.ownerUserId).toBe('u0');
    expect(d.reason).toBe('无人接单，老板兜底');
  });

  it('disabled 与达在跟上限者被跳过', () => {
    const ctx = makeCtx({ activeCount: new Map([['zhenjie', 30]]) });
    expect(routeLead(onlineInput(), ctx).ownerUserId).toBe('u2'); // 负责人乙达上限 → 销售甲
    const ctx2 = makeCtx({ disabled: new Set(['zhenjie', 'ajing']) });
    expect(routeLead(onlineInput(), ctx2).ownerUserId).toBe('u3'); // 请假 → 销售乙
  });

  it('池空/全不可用 → 老板兜底且 reason 含「兜底」', () => {
    const d = routeLead(onlineInput(), makeCtx({ onlinePool: [] }));
    expect(d.ownerUserId).toBe('u0');
    expect(d.reason).toContain('兜底');
    const d2 = routeLead(
      onlineInput(),
      makeCtx({ disabled: new Set(['zhenjie', 'ajing', 'amei']) }),
    );
    expect(d2.ownerUserId).toBe('u0');
    expect(d2.reason).toContain('兜底');
  });

  it('老板 username 无账号映射时 owner 留空（由导入侧记待兜底）', () => {
    const d = routeLead(onlineInput(), makeCtx({ onlinePool: [], userIdByUsername: new Map() }));
    expect(d.ownerUserId).toBeNull();
    expect(d.reason).toContain('兜底');
  });
});

describe('P3-03 分配路由（集成）', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let auth: AuthService;
  let assign: AssignService;
  let importService: LeadImportService;
  const password = 'S3cure-Passw0rd!';
  let leadSeq = 0;

  const mkUser = async (role: string): Promise<{ id: string; username: string; token: string }> => {
    const username = uniqueUsername(`la_${role}`);
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
    const user = await prisma.user.create({
      data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
    const res = await request(server).post('/api/v1/auth/login').send({ username, password });
    return { id: user.id, username, token: (res.body as { accessToken: string }).accessToken };
  };

  const newLeadNo = () => `L-${Date.now()}-${++leadSeq}`;

  const mkLead = (data: {
    sourcePlatform?: string;
    acquisitionMethod?: string | null;
    ownerUserId?: string | null;
    chatLink?: string | null;
    customerId?: string | null;
    dupOfLeadId?: string | null;
  }) =>
    prisma.lead.create({
      data: {
        leadNo: newLeadNo(),
        sourceCategory: 'online',
        sourcePlatform: data.sourcePlatform ?? '抖音',
        acquisitionMethod: data.acquisitionMethod ?? null,
        ownerUserId: data.ownerUserId ?? null,
        chatLink: data.chatLink ?? null,
        customerId: data.customerId ?? null,
        dupOfLeadId: data.dupOfLeadId ?? null,
      },
    });

  beforeAll(async () => {
    app = await buildApp();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    assign = app.get(AssignService);
    importService = app.get(LeadImportService);
    for (const code of ['boss', 'store_manager', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('线上普通客资连续 6 条平均分配并写 assignedAt＋assigned 事件＋推进游标', async () => {
    const boss = await mkUser('boss');
    const m1 = await mkUser('sales_ops');
    const m2 = await mkUser('sales_ops');
    const m3 = await mkUser('sales_ops');
    await prisma.systemMeta.upsert({
      where: { key: ASSIGN_META_KEYS.onlinePool },
      create: {
        key: ASSIGN_META_KEYS.onlinePool,
        value: JSON.stringify([m1.username, m2.username, m3.username]),
      },
      update: { value: JSON.stringify([m1.username, m2.username, m3.username]) },
    });
    await prisma.systemMeta.upsert({
      where: { key: ASSIGN_META_KEYS.boss },
      create: { key: ASSIGN_META_KEYS.boss, value: boss.username },
      update: { value: boss.username },
    });
    await prisma.systemMeta.upsert({
      where: { key: ASSIGN_META_KEYS.cursor },
      create: { key: ASSIGN_META_KEYS.cursor, value: '0' },
      update: { value: '0' },
    });

    const owners = new Map<string, number>();
    for (let i = 0; i < 6; i++) {
      const lead = await mkLead({ sourcePlatform: '抖音' });
      const result = await assign.route(lead);
      expect(result.ownerUserId).toBeTruthy();
      owners.set(result.ownerUserId!, (owners.get(result.ownerUserId!) ?? 0) + 1);

      const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.ownerUserId).toBe(result.ownerUserId);
      expect(persisted.assignedAt).not.toBeNull();
      const events = await prisma.leadEvent.findMany({
        where: { leadId: lead.id, kind: 'assigned' },
      });
      expect(events).toHaveLength(1);
    }
    expect(owners.get(m1.id)).toBe(2);
    expect(owners.get(m2.id)).toBe(2);
    expect(owners.get(m3.id)).toBe(2);

    const cursor = await prisma.systemMeta.findUnique({ where: { key: ASSIGN_META_KEYS.cursor } });
    expect(cursor?.value).toBe('6');
  });

  it('重复客资沿用主 Lead 负责人（route 落库）', async () => {
    await mkUser('boss');
    const owner = await mkUser('sales_ops');
    const primary = await mkLead({ ownerUserId: owner.id });
    const dup = await mkLead({ dupOfLeadId: primary.id });
    const result = await assign.route(dup);
    expect(result.ownerUserId).toBe(owner.id);
    const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: dup.id } });
    expect(persisted.ownerUserId).toBe(owner.id);
  });

  it('转介绍回原关系维护人（Customer.sourceReferralOwnerId）', async () => {
    const referralOwner = await mkUser('sales_ops');
    const customer = await prisma.customer.create({
      data: { name: '老客', phone: '13900000001', sourceReferralOwnerId: referralOwner.id },
    });
    const lead = await mkLead({ customerId: customer.id });
    const result = await assign.route(lead);
    expect(result.ownerUserId).toBe(referralOwner.id);
    expect(result.reason).toBe('转介绍回原关系维护人');
  });

  it('请假（disabled）销售被跳过，路由到下一位', async () => {
    const boss = await mkUser('boss');
    const disabled = await mkUser('sales_ops');
    const healthy = await mkUser('sales_ops');
    await prisma.user.update({ where: { id: disabled.id }, data: { disabled: true } });
    await prisma.systemMeta.upsert({
      where: { key: ASSIGN_META_KEYS.onlinePool },
      create: {
        key: ASSIGN_META_KEYS.onlinePool,
        value: JSON.stringify([disabled.username, healthy.username]),
      },
      update: { value: JSON.stringify([disabled.username, healthy.username]) },
    });
    await prisma.systemMeta.upsert({
      where: { key: ASSIGN_META_KEYS.boss },
      create: { key: ASSIGN_META_KEYS.boss, value: boss.username },
      update: { value: boss.username },
    });
    await prisma.systemMeta.upsert({
      where: { key: ASSIGN_META_KEYS.cursor },
      create: { key: ASSIGN_META_KEYS.cursor, value: '0' },
      update: { value: '0' },
    });
    const lead = await mkLead({ sourcePlatform: '抖音' });
    const result = await assign.route(lead);
    expect(result.ownerUserId).toBe(healthy.id);
  });

  it('到店客资不自动分配，接待人 claim 后 owner=claim 人且写 claim 事件', async () => {
    const host = await mkUser('sales_ops');
    const lead = await mkLead({ sourcePlatform: '到店' });
    expect(lead.ownerUserId).toBeNull();

    const res = await request(server)
      .post(`/api/v1/leads/${lead.id}/claim`)
      .set('Authorization', `Bearer ${host.token}`)
      .send({});
    expect(res.status).toBe(200);
    expect((res.body as { ownerUserId: string }).ownerUserId).toBe(host.id);

    const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(persisted.ownerUserId).toBe(host.id);
    const claimEvent = await prisma.leadEvent.findFirst({
      where: { leadId: lead.id, kind: 'claim' },
    });
    expect(claimEvent).not.toBeNull();

    // 已分配再认领 → LEAD_INVALID_STATE
    const again = await request(server)
      .post(`/api/v1/leads/${lead.id}/claim`)
      .set('Authorization', `Bearer ${host.token}`)
      .send({});
    expect(again.status).toBe(409);
    expect((again.body as { code: string }).code).toBe('LEAD_INVALID_STATE');
  });

  it('T5 并发认领竞态收口：他人已认领后另一人认领 409，先认领者归属不被覆盖', async () => {
    const first = await mkUser('sales_ops');
    const second = await mkUser('sales_ops');
    const lead = await mkLead({ sourcePlatform: '到店' });

    const res = await request(server)
      .post(`/api/v1/leads/${lead.id}/claim`)
      .set('Authorization', `Bearer ${first.token}`)
      .send({});
    expect(res.status).toBe(200);

    // 条件迁移表达并发语义：ownerUserId 已非空（被并发认领）→ updateIfUnclaimed count=0 → 409
    const raced = await request(server)
      .post(`/api/v1/leads/${lead.id}/claim`)
      .set('Authorization', `Bearer ${second.token}`)
      .send({});
    expect(raced.status).toBe(409);
    expect((raced.body as { code: string }).code).toBe('LEAD_INVALID_STATE');

    const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(persisted.ownerUserId).toBe(first.id);
    const claimEvents = await prisma.leadEvent.count({
      where: { leadId: lead.id, kind: 'claim' },
    });
    expect(claimEvents).toBe(1);
  });

  it('sales_ops 仅见本人客资（GET /leads scope 强制）；boss 全局', async () => {
    const boss = await mkUser('boss');
    const s1 = await mkUser('sales_ops');
    const s2 = await mkUser('sales_ops');
    await mkLead({ ownerUserId: s1.id, sourcePlatform: '抖音' });
    await mkLead({ ownerUserId: s2.id, sourcePlatform: '抖音' });
    await mkLead({ sourcePlatform: '抖音' }); // 未分配

    const asS1 = await request(server)
      .get('/api/v1/leads')
      .set('Authorization', `Bearer ${s1.token}`);
    expect(asS1.status).toBe(200);
    const s1Leads = asS1.body as { ownerUserId: string | null; ownerName: string | null }[];
    expect(s1Leads.length).toBe(1);
    expect(s1Leads[0].ownerUserId).toBe(s1.id);
    // 2026-08-28 bug1：列表必须带负责人显示名（前端直显，不再渲染内部 ID）
    expect(s1Leads[0].ownerName).toBe(s1.username);

    const asBoss = await request(server)
      .get('/api/v1/leads')
      .set('Authorization', `Bearer ${boss.token}`);
    expect(asBoss.status).toBe(200);
    expect((asBoss.body as unknown[]).length).toBeGreaterThanOrEqual(3);

    // 2026-08-28 bug1：负责人筛选按姓名（后端反查用户 ID）；无匹配姓名→空列表
    const byName = await request(server)
      .get(`/api/v1/leads?owner=${encodeURIComponent(s2.username)}`)
      .set('Authorization', `Bearer ${boss.token}`);
    expect(byName.status).toBe(200);
    const byNameBody = byName.body as { ownerUserId: string | null }[];
    expect(byNameBody.length).toBe(1);
    expect(byNameBody[0].ownerUserId).toBe(s2.id);
    const noMatch = await request(server)
      .get(`/api/v1/leads?owner=${encodeURIComponent('不存在的姓名-${s2.username}')}`)
      .set('Authorization', `Bearer ${boss.token}`);
    expect(noMatch.status).toBe(200);
    expect((noMatch.body as unknown[]).length).toBe(0);
  });

  it('chatLink 仅 boss/store_manager 可见，sales_ops 不可见', async () => {
    const boss = await mkUser('boss');
    const s1 = await mkUser('sales_ops');
    const lead = await mkLead({ ownerUserId: s1.id, chatLink: 'https://chat.example.com/secret' });

    const asS1 = await request(server)
      .get(`/api/v1/leads/${lead.id}`)
      .set('Authorization', `Bearer ${s1.token}`);
    expect(asS1.status).toBe(200);
    expect((asS1.body as { chatLink: string | null }).chatLink).toBeNull();

    const asBoss = await request(server)
      .get(`/api/v1/leads/${lead.id}`)
      .set('Authorization', `Bearer ${boss.token}`);
    expect(asBoss.status).toBe(200);
    expect((asBoss.body as { chatLink: string | null }).chatLink).toBe(
      'https://chat.example.com/secret',
    );
  });

  it('手动改派需 boss/store_manager 且 reason 必填', async () => {
    const boss = await mkUser('boss');
    const s1 = await mkUser('sales_ops');
    const s2 = await mkUser('sales_ops');
    const lead = await mkLead({ ownerUserId: s1.id });

    // 缺 reason → VALIDATION_FAILED（nestjs-zod 抛 400 系；契约只要求码一致）
    const noReason = await request(server)
      .patch(`/api/v1/leads/${lead.id}/assign`)
      .set('Authorization', `Bearer ${boss.token}`)
      .send({ ownerUserId: s2.id });
    expect([400, 422]).toContain(noReason.status);
    expect((noReason.body as { code: string }).code).toBe('VALIDATION_FAILED');

    // sales_ops 越权改派 → 403（有 m03:edit 但非全局角色）
    const asSales = await request(server)
      .patch(`/api/v1/leads/${lead.id}/assign`)
      .set('Authorization', `Bearer ${s1.token}`)
      .send({ ownerUserId: s2.id, reason: '试改派' });
    expect(asSales.status).toBe(403);

    // boss 改派成功
    const ok = await request(server)
      .patch(`/api/v1/leads/${lead.id}/assign`)
      .set('Authorization', `Bearer ${boss.token}`)
      .send({ ownerUserId: s2.id, reason: '调整为销售乙跟单' });
    expect(ok.status).toBe(200);
    const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(persisted.ownerUserId).toBe(s2.id);
  });

  it('畸形 assign.pool.online 配置回退默认并记 warn（不静默吞）', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const boss = await mkUser('boss');
    try {
      await prisma.systemMeta.upsert({
        where: { key: ASSIGN_META_KEYS.onlinePool },
        create: { key: ASSIGN_META_KEYS.onlinePool, value: '{bad json' },
        update: { value: '{bad json' },
      });
      await prisma.systemMeta.upsert({
        where: { key: ASSIGN_META_KEYS.boss },
        create: { key: ASSIGN_META_KEYS.boss, value: boss.username },
        update: { value: boss.username },
      });
      const lead = await mkLead({ sourcePlatform: '抖音' });
      // 回退默认池（ph-sales-ops 非测试账号，无映射）→ 老板兜底，且不抛错
      const result = await assign.route(lead);
      expect(result.ownerUserId).toBe(boss.id);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('配置解析失败'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('分配异常不阻断导入并记 warn 与「未分配待兜底」事件', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const boss = await mkUser('boss');
    const routeSpy = vi.spyOn(assign, 'route').mockRejectedValueOnce(new Error('route boom'));
    try {
      const dispatchNo = `D-${Date.now()}`;
      const rawText = [
        `派发NO：${dispatchNo}`,
        '日期：2026-08-14',
        '信息来源：抖音',
        `电话：138${String(Date.now()).slice(-8)}`,
        '需求：改色膜',
      ].join('\n');
      const result = await importService.confirmDispatch(
        { sub: boss.id, username: boss.username, type: 'access' },
        [rawText],
      );
      expect(result.created).toBe(1);

      const lead = await prisma.lead.findFirst({ where: { upstreamDispatchNo: dispatchNo } });
      expect(lead).not.toBeNull();
      expect(lead!.ownerUserId).toBeNull();
      const evt = await prisma.leadEvent.findFirst({
        where: { leadId: lead!.id, kind: 'assigned' },
      });
      expect((evt!.content as { reason: string }).reason).toBe('未分配待兜底');
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('自动分配失败'))).toBe(true);
    } finally {
      routeSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
