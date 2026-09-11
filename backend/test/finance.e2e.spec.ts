import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface EntryRow {
  id: string;
  direction: string;
  category: string;
  amountFen: number;
  occurredOn: string;
  remark: string | null;
  leadId: string | null;
  orderConfirmationId: string | null;
  createdBy: string | null;
}

/** 财务收支流水集成测试（M10 · 批次2）：append-only 登记——收入/支出创建与
 * direction×分类联动校验、时间窗过滤、m10:view/edit 权限分离、无删改端点、审计留痕 */
describe('财务收支流水（M10 · 批次2）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  // 每次运行唯一 tag：测试库数据跨运行残留，流水以 remark 含 tag 隔离与清扫
  const tag = Math.random().toString(36).slice(2, 8);
  let bossToken = '';
  let bossId = '';
  let managerToken = '';
  let managerId = '';
  let salesToken = '';
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
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username: uname, password });
    return { token: (res.body as { accessToken: string }).accessToken, id: user.id };
  };

  const api = () => request(app.getHttpServer() as Server);

  const createEntry = (token: string, extra: Record<string, unknown>) =>
    api().post('/api/v1/finance/entries').set('Authorization', `Bearer ${token}`).send(extra);

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const boss = await mkUser(uniqueUsername('m10fin_boss'), 'boss');
    bossToken = boss.token;
    bossId = boss.id;
    const manager = await mkUser(uniqueUsername('m10fin_manager'), 'store_manager');
    managerToken = manager.token;
    managerId = manager.id;
    salesToken = (await mkUser(uniqueUsername('m10fin_sales'), 'sales_ops')).token;
    recorderToken = (await mkUser(uniqueUsername('m10fin_recorder'), 'recorder')).token;
  });

  afterAll(async () => {
    // 清理口径：流水按 remark 含 tag 清扫（生产 append-only，仅测试库清扫本套件残留）
    await prisma.financeEntry.deleteMany({ where: { remark: { contains: tag } } });
    await app.close();
  });

  it('POST 收入/支出流水 → 201（金额分、分类枚举外 400）', async () => {
    // 收入：成交收款（金额一律分为单位）
    const income = await createEntry(bossToken, {
      direction: 'income',
      category: 'deal_receipt',
      amountFen: 128800,
      occurredOn: '2026-08-18T00:00:00.000Z',
      remark: `DM10 全车收款${tag}`,
    }).expect(201);
    const incomeRow = income.body as EntryRow;
    expect(incomeRow.id).toBeTruthy();
    expect(incomeRow.direction).toBe('income');
    expect(incomeRow.category).toBe('deal_receipt');
    expect(incomeRow.amountFen).toBe(128800);
    expect(incomeRow.createdBy).toBe(bossId);

    // 支出：房租（店长记账）
    const expense = await createEntry(managerToken, {
      direction: 'expense',
      category: 'rent',
      amountFen: 800000,
      occurredOn: '2026-08-01T00:00:00.000Z',
      remark: `8月房租${tag}`,
    }).expect(201);
    expect((expense.body as EntryRow).direction).toBe('expense');
    expect((expense.body as EntryRow).createdBy).toBe(managerId);

    // 金额：0/负数/小数一律 400（不允许零额与负额流水）
    await createEntry(bossToken, {
      direction: 'income',
      category: 'other',
      amountFen: 0,
      occurredOn: '2026-08-18T00:00:00.000Z',
      remark: `零额${tag}`,
    }).expect(400);
    await createEntry(bossToken, {
      direction: 'expense',
      category: 'other',
      amountFen: -500,
      occurredOn: '2026-08-18T00:00:00.000Z',
      remark: `负额${tag}`,
    }).expect(400);
    await createEntry(bossToken, {
      direction: 'expense',
      category: 'other',
      amountFen: 10.5,
      occurredOn: '2026-08-18T00:00:00.000Z',
      remark: `小数${tag}`,
    }).expect(400);

    // 分类与 direction 联动：支出方向不得用收入分类（反之亦然），枚举外分类一律 400
    const mismatch = await createEntry(bossToken, {
      direction: 'expense',
      category: 'deal_receipt',
      amountFen: 100,
      occurredOn: '2026-08-18T00:00:00.000Z',
      remark: `分类错配${tag}`,
    }).expect(400);
    expect((mismatch.body as { code: string }).code).toBe('VALIDATION_FAILED');
    await createEntry(bossToken, {
      direction: 'income',
      category: 'rent',
      amountFen: 100,
      occurredOn: '2026-08-18T00:00:00.000Z',
      remark: `分类错配2${tag}`,
    }).expect(400);
    await createEntry(bossToken, {
      direction: 'income',
      category: 'unknown_category',
      amountFen: 100,
      occurredOn: '2026-08-18T00:00:00.000Z',
      remark: `枚举外${tag}`,
    }).expect(400);
  });

  it('GET 列表按 direction 与时间窗过滤，occurredOn desc', async () => {
    // 造三条不同方向/日期的流水（remark 含 tag，跨运行隔离）
    const a = await createEntry(bossToken, {
      direction: 'income',
      category: 'deposit',
      amountFen: 50000,
      occurredOn: '2026-08-10T00:00:00.000Z',
      remark: `定金A${tag}`,
    }).expect(201);
    const aId = (a.body as EntryRow).id;
    const b = await createEntry(bossToken, {
      direction: 'expense',
      category: 'advertising',
      amountFen: 30000,
      occurredOn: '2026-08-20T00:00:00.000Z',
      remark: `广告投放B${tag}`,
    }).expect(201);
    const bId = (b.body as EntryRow).id;
    const c = await createEntry(bossToken, {
      direction: 'income',
      category: 'other',
      amountFen: 6600,
      occurredOn: '2026-08-30T00:00:00.000Z',
      remark: `其他收入C${tag}`,
    }).expect(201);
    const cId = (c.body as EntryRow).id;

    // direction 过滤（增量口径：只断言本套件 id 在/不在）
    const incomes = await api()
      .get('/api/v1/finance/entries?direction=income')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    const incomeRows = incomes.body as EntryRow[];
    expect(incomeRows.some((v) => v.id === aId)).toBe(true);
    expect(incomeRows.some((v) => v.id === cId)).toBe(true);
    expect(incomeRows.some((v) => v.id === bId)).toBe(false);

    // 时间窗过滤：from≤occurredOn≤to（区间内仅 B；A/C 在窗外）
    const window = await api()
      .get('/api/v1/finance/entries?from=2026-08-15T00:00:00.000Z&to=2026-08-25T00:00:00.000Z')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    const windowRows = window.body as EntryRow[];
    expect(windowRows.some((v) => v.id === bId)).toBe(true);
    expect(windowRows.some((v) => v.id === aId)).toBe(false);
    expect(windowRows.some((v) => v.id === cId)).toBe(false);

    // direction 与时间窗可叠加
    const combined = await api()
      .get(
        '/api/v1/finance/entries?direction=income&from=2026-08-01T00:00:00.000Z&to=2026-08-12T00:00:00.000Z',
      )
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    const combinedRows = combined.body as EntryRow[];
    expect(combinedRows.some((v) => v.id === aId)).toBe(true);
    expect(combinedRows.some((v) => v.id === cId)).toBe(false);

    // occurredOn desc：收入列表中 C（08-30）必在 A（08-10）之前
    const idxC = incomeRows.findIndex((v) => v.id === cId);
    const idxA = incomeRows.findIndex((v) => v.id === aId);
    expect(idxC).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxC).toBeLessThan(idxA);

    // direction 枚举外 → 400
    await api()
      .get('/api/v1/finance/entries?direction=bogus')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(400);
  });

  it('sales_ops POST → 403（无 m10:edit）；GET → 200（有 m10:view）', async () => {
    // sales_ops 经 ALL_MODULE_VIEW 持 m10:view，可查不可记
    await api()
      .get('/api/v1/finance/entries')
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    const denied = await createEntry(salesToken, {
      direction: 'expense',
      category: 'material',
      amountFen: 1000,
      occurredOn: '2026-08-18T00:00:00.000Z',
      remark: `销售越权记账${tag}`,
    }).expect(403);
    expect((denied.body as { code: string }).code).toBe('PERM_DENIED');

    // recorder 无 m10:view/m10:edit（显式白名单无）→ 查/记一律 403
    await api()
      .get('/api/v1/finance/entries')
      .set('Authorization', `Bearer ${recorderToken}`)
      .expect(403);
    await createEntry(recorderToken, {
      direction: 'expense',
      category: 'material',
      amountFen: 1000,
      occurredOn: '2026-08-18T00:00:00.000Z',
      remark: `记录员越权记账${tag}`,
    }).expect(403);
  });

  it('无删除/修改端点：DELETE/PATCH → 404（append-only 只增不改）', async () => {
    const created = await createEntry(bossToken, {
      direction: 'expense',
      category: 'equipment',
      amountFen: 250000,
      occurredOn: '2026-08-05T00:00:00.000Z',
      remark: `烤枪采购${tag}`,
    }).expect(201);
    const id = (created.body as EntryRow).id;

    await api()
      .delete(`/api/v1/finance/entries/${id}`)
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(404);
    await api()
      .patch(`/api/v1/finance/entries/${id}`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ amountFen: 1 })
      .expect(404);

    // 行未被改动：金额与备注保持原值
    const row = await prisma.financeEntry.findUniqueOrThrow({ where: { id } });
    expect(row.amountFen).toBe(250000);
    expect(row.remark).toContain(tag);
  });

  it('审计行 finance_entry.created 留痕', async () => {
    const created = await createEntry(managerToken, {
      direction: 'income',
      category: 'deposit',
      amountFen: 20000,
      occurredOn: '2026-08-22T00:00:00.000Z',
      remark: `定金留痕${tag}`,
    }).expect(201);
    const id = (created.body as EntryRow).id;

    const audit = await prisma.auditLog.findFirst({
      where: {
        objectType: 'finance_entry',
        objectId: id,
        action: 'finance_entry.created',
      },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorId).toBe(managerId);
    // after 快照含方向/分类/金额（分）
    expect(audit!.after as object).toMatchObject({
      direction: 'income',
      category: 'deposit',
      amountFen: 20000,
    });
  });
});
