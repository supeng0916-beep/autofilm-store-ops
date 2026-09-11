import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface ApprovalRow {
  id: string;
  type: string;
  status: string;
  requesterId: string;
  decidedAt: string | null;
  opinion: string | null;
}
interface ErrorBody {
  code: string;
}

describe('审批队列框架（P1-05）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const suffix = Date.now().toString(36);
  const password = 'S3cure-Passw0rd!';
  let bossToken = '';
  let managerToken = '';
  let salesToken = '';
  let recorderToken = '';
  let bossId = '';
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
    return { token: (res.body as { accessToken: string }).accessToken, id: user.id };
  };

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    // 用户名统一经 uniqueUsername（P1 遗留 T8-1 回收）：随机段保证跨套件不撞唯一键
    const boss = await mkUser(uniqueUsername('ap8_boss'), 'boss');
    bossToken = boss.token;
    bossId = boss.id;
    const manager = await mkUser(uniqueUsername('ap8_manager'), 'store_manager');
    managerToken = manager.token;
    const sales = await mkUser(uniqueUsername('ap8_sales'), 'sales_ops');
    salesToken = sales.token;
    salesId = sales.id;
    const recorder = await mkUser(uniqueUsername('ap8_recorder'), 'recorder');
    recorderToken = recorder.token;
  });

  afterAll(async () => {
    await app.close();
  });

  it('发起：sales_ops 可发起；recorder 被拒（矩阵 ❌）', async () => {
    const ok = await request(app.getHttpServer() as Server)
      .post('/api/v1/approvals')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ type: 'quote_discount', payload: { opportunityId: 'demo' }, basis: '客户议价' });
    expect(ok.status).toBe(201);
    expect((ok.body as ApprovalRow).status).toBe('pending');

    const denied = await request(app.getHttpServer() as Server)
      .post('/api/v1/approvals')
      .set('Authorization', `Bearer ${recorderToken}`)
      .send({ type: 'generic', payload: {} });
    expect(denied.status).toBe(403);
    expect((denied.body as ErrorBody).code).toBe('PERM_DENIED');
  });

  it('列表：按状态过滤；recorder 无 approval:view 被拒', async () => {
    const list = await request(app.getHttpServer() as Server)
      .get('/api/v1/approvals?status=pending')
      .set('Authorization', `Bearer ${bossToken}`);
    expect(list.status).toBe(200);
    expect((list.body as ApprovalRow[]).every((r) => r.status === 'pending')).toBe(true);

    const denied = await request(app.getHttpServer() as Server)
      .get('/api/v1/approvals')
      .set('Authorization', `Bearer ${recorderToken}`);
    expect(denied.status).toBe(403);
  });

  it('2026-08-28 UI 测试 #8 数据范围：无 approval:decide 的销售只看本人发起的审批', async () => {
    const created = await request(app.getHttpServer() as Server)
      .post('/api/v1/approvals')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ type: 'generic', payload: { summary: `范围用例-${suffix}` } });
    expect(created.status).toBe(201);

    const asSales = await request(app.getHttpServer() as Server)
      .get('/api/v1/approvals')
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    const rows = asSales.body as ApprovalRow[];
    expect(rows.length).toBeGreaterThan(0);
    // 全部为本人发起：他人审批的 payload 业务详情不外泄
    expect(rows.every((r) => r.requesterId === salesId)).toBe(true);
    expect(rows.some((r) => r.id === (created.body as ApprovalRow).id)).toBe(true);

    // 审批人（boss 有 approval:decide）仍全量可见
    const asBoss = await request(app.getHttpServer() as Server)
      .get('/api/v1/approvals')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    expect(
      (asBoss.body as ApprovalRow[]).some((r) => r.id === (created.body as ApprovalRow).id),
    ).toBe(true);
    expect((asBoss.body as ApprovalRow[]).some((r) => r.requesterId !== bossId)).toBe(true);
  });

  it('approve 缺 confirmed:true → VALIDATION_FAILED', async () => {
    const created = await request(app.getHttpServer() as Server)
      .post('/api/v1/approvals')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ type: 'generic', payload: { k: 'v' } });
    const { id } = created.body as ApprovalRow;

    const res = await request(app.getHttpServer() as Server)
      .post(`/api/v1/approvals/${id}/approve`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ opinion: '同意' });
    expect([400, 422]).toContain(res.status);
    expect((res.body as ErrorBody).code).toBe('VALIDATION_FAILED');
  });

  it('approve 成功：pending→approved，decidedAt 非空，写审计；重复批准 → APPROVAL_INVALID_STATE', async () => {
    const created = await request(app.getHttpServer() as Server)
      .post('/api/v1/approvals')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ type: 'quote_discount', payload: { amount: 100 } });
    const { id } = created.body as ApprovalRow;

    const approved = await request(app.getHttpServer() as Server)
      .post(`/api/v1/approvals/${id}/approve`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ confirmed: true, opinion: '同意' });
    expect(approved.status).toBe(201);
    const row = await prisma.approvalItem.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('approved');
    expect(row.decidedAt).not.toBeNull();
    expect(row.approverId).toBe(bossId);

    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'approval', objectId: id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual(['approval.created', 'approval.approved']);

    const again = await request(app.getHttpServer() as Server)
      .post(`/api/v1/approvals/${id}/approve`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ confirmed: true });
    expect(again.status).toBe(409);
    expect((again.body as ErrorBody).code).toBe('APPROVAL_INVALID_STATE');
  });

  it('reject：理由 <5 字被拒；合法驳回后状态 rejected + 审计', async () => {
    const created = await request(app.getHttpServer() as Server)
      .post('/api/v1/approvals')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ type: 'content_publish', payload: { title: '草稿' } });
    const { id } = created.body as ApprovalRow;

    const short = await request(app.getHttpServer() as Server)
      .post(`/api/v1/approvals/${id}/reject`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ confirmed: true, reason: '不行' });
    expect([400, 422]).toContain(short.status);
    expect((short.body as ErrorBody).code).toBe('VALIDATION_FAILED');

    const rejected = await request(app.getHttpServer() as Server)
      .post(`/api/v1/approvals/${id}/reject`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ confirmed: true, reason: '素材未授权，不能发布' });
    expect(rejected.status).toBe(201);
    const row = await prisma.approvalItem.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('rejected');
    expect(row.opinion).toBe('素材未授权，不能发布');

    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'approval', objectId: id, action: 'approval.rejected' },
    });
    expect(audits).toHaveLength(1);
  });

  it('withdraw：仅发起人、仅 pending；已决项撤回 → APPROVAL_INVALID_STATE', async () => {
    const created = await request(app.getHttpServer() as Server)
      .post('/api/v1/approvals')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ type: 'generic', payload: { k: 1 } });
    const { id } = created.body as ApprovalRow;
    expect((created.body as ApprovalRow).requesterId).toBe(salesId);

    const byOther = await request(app.getHttpServer() as Server)
      .post(`/api/v1/approvals/${id}/withdraw`)
      .set('Authorization', `Bearer ${bossToken}`);
    expect(byOther.status).toBe(403);
    expect((byOther.body as ErrorBody).code).toBe('PERM_DENIED');

    const byOwner = await request(app.getHttpServer() as Server)
      .post(`/api/v1/approvals/${id}/withdraw`)
      .set('Authorization', `Bearer ${salesToken}`);
    expect(byOwner.status).toBe(201);
    expect((await prisma.approvalItem.findUniqueOrThrow({ where: { id } })).status).toBe(
      'withdrawn',
    );

    const again = await request(app.getHttpServer() as Server)
      .post(`/api/v1/approvals/${id}/withdraw`)
      .set('Authorization', `Bearer ${salesToken}`);
    expect(again.status).toBe(409);
    expect((again.body as ErrorBody).code).toBe('APPROVAL_INVALID_STATE');
  });

  it('未批准项无对外出口：批准前后 leads/appointments 计数不变（结构核对）', async () => {
    // 结构断言：approval_items 仅有本模块读写，P2+ 执行器接入前无消费方。
    // 用一条已批准项验证：批准后除状态/审计外，库内无任何新业务行产生。
    // 采用「批准前后两表计数不变」而非「全库为 0」，避免并发套件写入造成干扰（简报注释方案）。
    const before = await prisma.auditLog.count();
    const leadsBefore = await prisma.lead.count();
    const appointmentsBefore = await prisma.appointment.count();
    const created = await request(app.getHttpServer() as Server)
      .post('/api/v1/approvals')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ type: 'generic', payload: { probe: suffix } });
    await request(app.getHttpServer() as Server)
      .post(`/api/v1/approvals/${(created.body as ApprovalRow).id}/approve`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ confirmed: true });
    expect(await prisma.lead.count()).toBe(leadsBefore);
    expect(await prisma.appointment.count()).toBe(appointmentsBefore);
    expect(await prisma.auditLog.count()).toBeGreaterThan(before);
  });

  it('发起人自审允许（V1 决策，P6 复核）：sales 发起并由兼任审批权限者批准', async () => {
    // boss 既是发起人又是审批人的场景：此处验证 boss 发起 + boss 批准不被系统阻止
    const created = await request(app.getHttpServer() as Server)
      .post('/api/v1/approvals')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ type: 'sensitive_export', payload: { scope: 'demo' } });
    const { id } = created.body as ApprovalRow;
    expect((created.body as ApprovalRow).requesterId).toBe(bossId);
    const approved = await request(app.getHttpServer() as Server)
      .post(`/api/v1/approvals/${id}/approve`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ confirmed: true });
    expect(approved.status).toBe(201);
  });
});
