/** 住宅膜勘测字段（批次3 T2）：homeSurvey 随施工单创建/回读；非住宅单不传不受影响。 */
import type { Server } from 'node:http';

import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  GatewayRunResult,
  OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

const password = 'S3cure-Passw0rd!';

class NullGateway implements OpenClawGateway {
  submit(_req: SubmitTaskRequest): Promise<GatewayRunResult> {
    void _req;
    return Promise.resolve({ status: 'done', output: { ok: true } });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve(void 0);
  }
}

describe('住宅膜勘测字段（批次3 T2）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let recorderToken = '';
  let apptId = '';
  const cleanup: { apptIds: string[]; woIds: string[]; customerIds: string[] } = {
    apptIds: [],
    woIds: [],
    customerIds: [],
  };

  beforeAll(async () => {
    app = await buildApp(new NullGateway());
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['recorder', 'store_manager']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const mk = async (role: string) => {
      const username = uniqueUsername('hs');
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
    recorderToken = await mk('recorder');
    void mk('store_manager');
    // 造已确认预约（home_film 类型，技师须有对应技能——住宅膜用通用断言：直接确认排期）
    const customer = await prisma.customer.create({
      data: { name: '勘测测试', phone: '13800009999' },
    });
    cleanup.customerIds.push(customer.id);
    const appt = await prisma.appointment.create({
      data: {
        customerId: customer.id,
        startAt: new Date(Date.now() + 86_400_000),
        serviceItem: '住宅玻璃膜',
        businessType: 'home_film',
        status: 'confirmed',
        managerConfirmed: true,
      },
    });
    apptId = appt.id;
    cleanup.apptIds.push(apptId);
  });
  afterAll(async () => {
    await prisma.workOrder.deleteMany({ where: { id: { in: cleanup.woIds } } });
    await prisma.appointment.deleteMany({ where: { id: { in: cleanup.apptIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: cleanup.customerIds } } });
    await app.close();
  });

  it('创建带勘测字段的住宅膜工单 → 回读 homeSurvey', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/work-orders')
      .set('Authorization', `Bearer ${recorderToken}`)
      .send({
        appointmentId: apptId,
        technicianName: '演示技师 C',
        homeSurvey: {
          glassArea: '约 25 ㎡',
          orientation: '南向+西晒',
          glassMaterial: '中空双层',
          propertyCondition: '物业周日可进场，需提前登记',
        },
      })
      .expect(201);
    const wo = res.body as { id: string; homeSurvey: Record<string, string> | null };
    cleanup.woIds.push(wo.id);
    expect(wo.homeSurvey).toMatchObject({ glassArea: '约 25 ㎡', orientation: '南向+西晒' });
  });

  it('不传 homeSurvey 的普通工单不受影响（null）', async () => {
    // 一预约一单（bug4 口径）：另造一单用新预约
    const appt2 = await prisma.appointment.create({
      data: {
        customerId: cleanup.customerIds[0],
        startAt: new Date(Date.now() + 2 * 86_400_000),
        serviceItem: '住宅玻璃膜二单',
        businessType: 'home_film',
        status: 'confirmed',
        managerConfirmed: true,
      },
    });
    cleanup.apptIds.push(appt2.id);
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/work-orders')
      .set('Authorization', `Bearer ${recorderToken}`)
      .send({ appointmentId: appt2.id, technicianName: '演示技师 C' })
      .expect(201);
    const wo = res.body as { id: string; homeSurvey: Record<string, string> | null };
    cleanup.woIds.push(wo.id);
    expect(wo.homeSurvey).toBeNull();
  });
});
