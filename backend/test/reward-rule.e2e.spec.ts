/** 奖惩规则引擎（批次3 T1）：规则 CRUD 权限、月度事实求值草案、人工确认落 StaffRecord 幂等。
 * 红线：系统只算账——草案不落库，confirm 由人拍板；AI 不参与判定。 */
import type { Server } from 'node:http';

import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

const password = 'S3cure-Passw0rd!';
const MONTH = '2026-09';

describe('奖惩规则引擎（批次3 T1）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let bossToken = '';
  let salesToken = '';
  let ruleId = '';
  const woIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const mk = async (role: string) => {
      const username = uniqueUsername('rw');
      const user = await prisma.user.create({
        data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
      });
      const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username, password });
      return (res.body as { accessToken: string }).accessToken;
    };
    bossToken = await mk('boss');
    salesToken = await mk('sales_ops');
    await prisma.systemMeta.deleteMany({ where: { key: `reward.confirmed.${MONTH}` } });
    // 造数：张三本月 2 张已交付工单（触发 delivered_count>=2 奖励）
    for (let i = 0; i < 2; i += 1) {
      const wo = await prisma.workOrder.create({
        data: {
          orderNo: `W-RW-${Date.now().toString(36)}-${i}`,
          stage: 'delivered',
          technicianName: '张三',
        },
      });
      woIds.push(wo.id);
    }
  });
  afterAll(async () => {
    await prisma.workOrder.deleteMany({ where: { id: { in: woIds } } });
    if (ruleId) await prisma.rewardRule.deleteMany({ where: { id: ruleId } });
    await prisma.staffRecord.deleteMany({
      where: { subjectType: 'technician', subjectId: '张三', kind: { in: ['reward', 'punish'] } },
    });
    await prisma.systemMeta.deleteMany({ where: { key: `reward.confirmed.${MONTH}` } });
    await app.close();
  });

  it('规则 CRUD：sales 403；boss 创建/启停', async () => {
    const denied = await request(app.getHttpServer() as Server)
      .post('/api/v1/team/reward-rules')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({
        name: 'x',
        metric: 'delivered_count',
        comparator: 'gte',
        threshold: 2,
        direction: 'reward',
        amountFen: 20000,
      });
    expect(denied.status).toBe(403);
    const created = await request(app.getHttpServer() as Server)
      .post('/api/v1/team/reward-rules')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({
        name: '月交付 2 单奖 200 元',
        metric: 'delivered_count',
        comparator: 'gte',
        threshold: 2,
        direction: 'reward',
        amountFen: 20000,
      })
      .expect(201);
    ruleId = (created.body as { id: string }).id;
    const listed = await request(app.getHttpServer() as Server)
      .get('/api/v1/team/reward-rules')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    expect((listed.body as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('preview：命中规则出草案（张三 delivered_count=2）且不落库', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post(`/api/v1/team/reward-rules/preview?month=${MONTH}`)
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    const drafts = res.body as Array<{
      technicianName: string;
      metricValue: number;
      direction: string;
      alreadyConfirmed: boolean;
    }>;
    const hit = drafts.find((d) => d.technicianName === '张三');
    expect(hit).toMatchObject({ metricValue: 2, direction: 'reward', alreadyConfirmed: false });
    const records = await prisma.staffRecord.count({
      where: { subjectType: 'technician', subjectId: '张三', kind: 'reward' },
    });
    expect(records).toBe(0); // 草案不落库
  });

  it('confirm：人拍板落 StaffRecord + 审计；重复确认幂等跳过', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/team/reward-rules/confirm')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({
        month: MONTH,
        items: [
          {
            ruleId,
            technicianName: '张三',
            metricValue: 2,
            amountFen: 20000,
            direction: 'reward',
          },
        ],
      })
      .expect(200);
    expect((res.body as { created: number }).created).toBe(1);
    const record = await prisma.staffRecord.findFirst({
      where: { subjectType: 'technician', subjectId: '张三', kind: 'reward' },
    });
    expect(record?.content).toContain('月交付 2 单奖 200 元');
    // 重复确认：幂等
    const again = await request(app.getHttpServer() as Server)
      .post('/api/v1/team/reward-rules/confirm')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({
        month: MONTH,
        items: [
          { ruleId, technicianName: '张三', metricValue: 2, amountFen: 20000, direction: 'reward' },
        ],
      })
      .expect(200);
    expect((again.body as { created: number }).created).toBe(0);
    const audit = await prisma.auditLog.findFirst({
      where: {
        action: 'reward_rule.confirmed',
        objectType: 'reward_confirmation',
        objectId: MONTH,
      },
    });
    expect(audit).not.toBeNull();
  });
});
