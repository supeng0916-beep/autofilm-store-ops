/** 聚合器（V1.5 Task3/4）：确定性查询+权限过滤（无 ai:cost:view → 无 aiOps 区块）+空态。 */
import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BossAggregator } from '../src/modules/agent/aggregators/boss.aggregator';
import { ManagerAggregator } from '../src/modules/agent/aggregators/manager.aggregator';
import { serializeStructuredContext } from '../src/modules/agent/aggregators/role-context';
import type { JwtPayload } from '../src/modules/auth/auth.types';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

const password = 'S3cure-Passw0rd!';

describe('角色聚合器（V1.5）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let boss: BossAggregator;
  let manager: ManagerAggregator;
  // 最小 JwtPayload（聚合器只用 sub/username）
  let actor: JwtPayload;
  let bossUserId = '';

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    boss = app.get(BossAggregator);
    manager = app.get(ManagerAggregator);
    for (const code of ['boss', 'store_manager', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    // 共享测试库隔离：清历史运行的中间态残留（中断套件遗留的 pending 审批与本套件 L-AG 客资）
    await prisma.approvalItem.deleteMany({ where: { status: 'pending' } });
    await prisma.orderConfirmation.deleteMany({ where: { status: 'draft' } });
    await prisma.lead.deleteMany({ where: { leadNo: { startsWith: 'L-AG-' } } });
    const username = uniqueUsername('ag');
    const user = await prisma.user.create({
      data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'boss' } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    actor = { sub: user.id, username, type: 'access' };
    bossUserId = user.id;
  });
  afterAll(async () => {
    await app.close();
  });

  it('BossAggregator：区块齐全，空库返回"暂无"空态；序列化含区块键', async () => {
    const blocks = await boss.collect(actor);
    expect(blocks.map((b) => b.key)).toEqual([
      'approvals',
      'orders',
      'aiOps',
      'dueToday',
      'overdue',
      'intakeQuality',
    ]);
    // 空库时 approvals/orders/dueToday/overdue 为暂无；aiOps（boss 恒有）与 intakeQuality 有实数
    const byKey = Object.fromEntries(blocks.map((b) => [b.key, b]));
    expect(byKey.approvals.summary).toContain('暂无');
    expect(byKey.orders.summary).toContain('暂无');
    const text = serializeStructuredContext(blocks);
    expect(text).toContain('【approvals】');
    expect(text).toContain('【intakeQuality】');
  });

  it('BossAggregator：造数后区块反映事实（approval/order/到期跟进）', async () => {
    const approval = await prisma.approvalItem.create({
      data: {
        type: 'knowledge.publish',
        payload: { title: '价格表v2' },
        requesterId: bossUserId,
      },
    });
    const lead = await prisma.lead.create({
      data: {
        leadNo: 'L-AG-1',
        sourceCategory: 'offline',
        sourcePlatform: 'test',
        stage: 'new',
        intentLevel: 'high',
        nextFollowUpAt: new Date(Date.now() - 86_400_000), // 昨天到期 → overdue
        ownerUserId: bossUserId,
      },
    });
    const order = await prisma.orderConfirmation.create({
      data: {
        leadId: lead.id,
        products: 'DM04+DM12 组合',
        quoteSnapshot: '{}',
        depositFen: 300000,
        status: 'draft',
      },
    });
    const blocks = await boss.collect(actor);
    const byKey = Object.fromEntries(blocks.map((b) => [b.key, b]));
    expect(byKey.approvals.summary).not.toContain('暂无');
    expect(byKey.approvals.items.join()).toContain('价格表v2');
    expect(byKey.orders.summary).toContain('订单 1 单');
    expect(byKey.orders.items.join()).toContain('DM04+DM12 组合');
    expect(byKey.overdue.summary).toContain('超期未跟进 1 条');
    expect(byKey.overdue.items.join()).toContain('L-AG-1');
    // 清理
    await prisma.orderConfirmation.deleteMany({ where: { id: order.id } });
    await prisma.approvalItem.deleteMany({ where: { id: approval.id } });
    await prisma.lead.deleteMany({ where: { id: lead.id } });
  });

  it('权限过滤：无 ai:cost:view 的 actor 收不到 aiOps 区块', async () => {
    const username = uniqueUsername('ag2');
    const user = await prisma.user.create({
      data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'sales_ops' } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const blocks = await boss.collect({ sub: user.id, username, type: 'access' });
    expect(blocks.map((b) => b.key)).not.toContain('aiOps');
  });

  it('ManagerAggregator：区块齐全（appointments/techChanges/workOrders/load）', async () => {
    const blocks = await manager.collect(actor);
    expect(blocks.map((b) => b.key)).toEqual(['appointments', 'techChanges', 'workOrders', 'load']);
  });

  it('ManagerAggregator：待确认预约/技师变更/施工工单反映事实', async () => {
    const customer = await prisma.customer.create({
      data: { name: '测试客户', phone: '13800000000' },
    });
    const appt = await prisma.appointment.create({
      data: {
        customerId: customer.id,
        startAt: new Date(Date.now() + 3_600_000),
        serviceItem: '全车膜',
        status: 'pending',
        managerConfirmed: false,
      },
    });
    const change = await prisma.appointmentTechnicianChange.create({
      data: {
        appointmentId: appt.id,
        fromName: '张三',
        toName: '李四',
        reason: '请假',
        requestedBy: bossUserId,
      },
    });
    const wo = await prisma.workOrder.create({
      data: {
        orderNo: `W-AG-${Date.now().toString(36)}`,
        stage: 'in_progress',
        technicianName: '李四',
      },
    });
    const blocks = await manager.collect(actor);
    const byKey = Object.fromEntries(blocks.map((b) => [b.key, b]));
    expect(byKey.appointments.summary).toContain('1');
    expect(byKey.appointments.items.join()).toContain('全车膜');
    expect(byKey.techChanges.summary).toContain('1');
    expect(byKey.techChanges.items.join()).toContain('李四');
    expect(byKey.workOrders.summary).toContain('1');
    expect(byKey.load.summary).toContain('李四');
    // 清理
    await prisma.appointmentTechnicianChange.deleteMany({ where: { id: change.id } });
    await prisma.appointment.deleteMany({ where: { id: appt.id } });
    await prisma.workOrder.deleteMany({ where: { id: wo.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  });
});
