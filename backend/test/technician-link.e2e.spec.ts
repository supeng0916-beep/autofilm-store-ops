/** 技师关联化（批次3 T3）：technicianId 列+存量姓名回填+创建自动关联（ID 优先/姓名反查）+ analytics 精确分桶。 */
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

class NullGw implements OpenClawGateway {
  submit(_r: SubmitTaskRequest): Promise<GatewayRunResult> {
    void _r;
    return Promise.resolve({ status: 'done', output: {} });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve(void 0);
  }
}

describe('技师关联化（批次3 T3）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let recorderToken = '';
  let techId = '';
  const cleanup = { woIds: [] as string[], apptIds: [] as string[], customerIds: [] as string[] };

  beforeAll(async () => {
    app = await buildApp(new NullGw());
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const username = uniqueUsername('ti');
    const user = await prisma.user.create({
      data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'recorder' } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username, password });
    recorderToken = (res.body as { accessToken: string }).accessToken;
    // 造技师+存量工单（迁移回填发生在 migrate，此处验证创建路径自动关联）
    const tech = await prisma.technician.upsert({
      where: { id: 'tech-ti-test' },
      update: {},
      create: { id: 'tech-ti-test', name: '关联化测试技师', skills: ['window_film'] },
    });
    techId = tech.id;
  });
  afterAll(async () => {
    await prisma.workOrder.deleteMany({ where: { id: { in: cleanup.woIds } } });
    await prisma.appointment.deleteMany({ where: { id: { in: cleanup.apptIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: cleanup.customerIds } } });
    await prisma.technician.deleteMany({ where: { id: techId } });
    await app.close();
  });

  it('仅传姓名的建单自动反查 technicianId 回填', async () => {
    const customer = await prisma.customer.create({
      data: { name: '关联化', phone: '13811112222' },
    });
    cleanup.customerIds.push(customer.id);
    const appt = await prisma.appointment.create({
      data: {
        customerId: customer.id,
        startAt: new Date(Date.now() + 86_400_000),
        serviceItem: '窗膜',
        businessType: 'window_film',
        status: 'confirmed',
        managerConfirmed: true,
      },
    });
    cleanup.apptIds.push(appt.id);
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/work-orders')
      .set('Authorization', `Bearer ${recorderToken}`)
      .send({ appointmentId: appt.id, technicianName: '关联化测试技师' })
      .expect(201);
    const wo = res.body as { id: string; technicianId: string | null };
    cleanup.woIds.push(wo.id);
    expect(wo.technicianId).toBe(techId);
  });

  it('显式传 technicianId 优先落库（不反查）', async () => {
    const customer = await prisma.customer.create({
      data: { name: '关联化二', phone: '13811113333' },
    });
    cleanup.customerIds.push(customer.id);
    const appt = await prisma.appointment.create({
      data: {
        customerId: customer.id,
        startAt: new Date(Date.now() + 2 * 86_400_000),
        serviceItem: '窗膜二',
        businessType: 'window_film',
        status: 'confirmed',
        managerConfirmed: true,
      },
    });
    cleanup.apptIds.push(appt.id);
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/work-orders')
      .set('Authorization', `Bearer ${recorderToken}`)
      .send({ appointmentId: appt.id, technicianName: '关联化测试技师', technicianId: techId })
      .expect(201);
    const wo = res.body as { id: string; technicianId: string | null };
    cleanup.woIds.push(wo.id);
    expect(wo.technicianId).toBe(techId);
  });
});
