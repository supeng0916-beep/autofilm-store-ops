import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

import { uniqueUsername } from './helpers/unique';
import { TEST_DATABASE_URL } from './test-env';

/** P1-04 基线冒烟：直连测试库验证关键表可读写、约束生效。
 * 不用 PrismaService（避免拉起整个 Nest 装配），Prisma 7 必须传适配器。 */
describe('数据模型基线（P1-04）', () => {
  const db = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: TEST_DATABASE_URL,
    }),
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('users/roles/user_roles 关联可读写', async () => {
    const uname = uniqueUsername('u');
    const roleCode = uniqueUsername('r');
    const user = await db.user.create({
      data: { username: uname, passwordHash: 'x', displayName: '测试' },
    });
    const role = await db.role.create({ data: { code: roleCode, name: '测试角色' } });
    await db.userRole.create({ data: { userId: user.id, roleId: role.id } });

    const found = await db.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { userRoles: { include: { role: true } } },
    });
    expect(found.userRoles[0]?.role.code).toBe(roleCode);
  });

  it('leads 索引字段可查询（阶段/负责人）', async () => {
    const rows = await db.lead.findMany({ where: { stage: 'new', ownerUserId: null } });
    expect(Array.isArray(rows)).toBe(true);
  });

  it('opportunities 含到店成交记录字段', async () => {
    const opp = await db.opportunity.create({
      data: {
        stage: 'new',
        carModel: '车型A',
        competitionCompare: '竞品X',
        visitOriginalPlan: '原方案',
        visitFinalPlan: '最终方案',
        upsellReason: '升单原因',
        grossMarginImpact: '+5%',
      },
    });
    expect(opp.visitOriginalPlan).toBe('原方案');
    expect(opp.grossMarginImpact).toBe('+5%');
  });

  it('audit_logs 可写入；knowledge_embeddings 向量列存在', async () => {
    await db.auditLog.create({
      data: { action: 'test.probe', objectType: 'spec', actorName: 'schema-baseline' },
    });
    const cols = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
      "select column_name from information_schema.columns where table_name = 'knowledge_embeddings'",
    );
    expect(cols.map((c) => c.column_name)).toContain('embedding');
  });

  it('缺口补齐批次后业务表共 37 张（V2.4+M09+陪练+奖惩+同行动态+客户评价+灵感库）', async () => {
    // 口径与 P1「18 表」一致：不含 init 迁移的 SystemMeta 与 Prisma 内部表 _prisma_migrations；
    // M09 批次1 新增五表：aftercare_visits / service_requests / warranty_registrations /
    // referral_records / order_confirmations（迁移 20260901060715_m09_order_confirmation）；
    // 缺口补齐批次新增 customer_reviews（迁移 20260903175004_customer_review，35→36）；
    // 短视频批次B 新增 video_inspirations（迁移 20260907075036_video_inspirations，36→37）
    const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(
      "select count(*)::int as n from information_schema.tables where table_schema = 'public'" +
        " and table_type = 'BASE TABLE' and table_name not in ('SystemMeta', '_prisma_migrations')",
    );
    expect(rows[0]?.n).toBe(37);
  });

  it('ai_task_events 存在；ai_tasks 含 P2 新列（deadline_at/cost_estimate_fen 等六列）', async () => {
    const eventCols = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
      "select column_name from information_schema.columns where table_name = 'ai_task_events'",
    );
    expect(eventCols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining(['id', 'task_id', 'from_status', 'to_status', 'reason', 'created_at']),
    );

    const taskCols = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
      "select column_name from information_schema.columns where table_name = 'ai_tasks'",
    );
    expect(taskCols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        'deadline_at',
        'dispatched_at',
        'callback_at',
        'finished_at',
        'error_message',
        'cost_estimate_fen',
      ]),
    );
  });

  it('P3 后 leads 含字段字典新列；import_batches 含 kind', async () => {
    const leadCols = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
      "select column_name from information_schema.columns where table_name = 'leads'",
    );
    expect(leadCols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        'lead_no',
        'final_status',
        'silence_stage',
        'intent_level',
        'received_at',
        'upstream_dispatch_at',
      ]),
    );

    const batchCols = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
      "select column_name from information_schema.columns where table_name = 'import_batches'",
    );
    expect(batchCols.map((c) => c.column_name)).toContain('kind');
  });
});
