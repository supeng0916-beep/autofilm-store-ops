/** 客资画像接入（批次2 T4）：PATCH /leads/:id/profile 五字段（枚举校验+至少一项）+
 * 导入模板五列（中文表头，选填，枚举空值通过非空必命中）。 */
import type { Server } from 'node:http';

import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HEADER_MAP, ImportRowSchema } from '../src/modules/lead/import/row-schema';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

const password = 'S3cure-Passw0rd!';

describe('客资画像（批次2 T4）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let salesToken = '';
  let recorderToken = '';
  let leadId = '';
  const leadNos: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const mk = async (role: string) => {
      const username = uniqueUsername('pf');
      const user = await prisma.user.create({
        data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
      });
      const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username, password });
      return { token: (res.body as { accessToken: string }).accessToken, id: user.id };
    };
    const sales = await mk('sales_ops');
    salesToken = sales.token;
    recorderToken = (await mk('recorder')).token;
    const lead = await prisma.lead.create({
      data: {
        leadNo: 'L-PF-1',
        sourceCategory: 'offline',
        sourcePlatform: 't',
        stage: 'new',
        ownerUserId: sales.id,
      },
    });
    leadId = lead.id;
    leadNos.push('L-PF-1');
  });
  afterAll(async () => {
    await prisma.lead.deleteMany({ where: { leadNo: { in: leadNos } } });
    await app.close();
  });

  it('PATCH 画像：枚举合法 → 200 且详情可见；留审计 lead.profile_updated', async () => {
    const res = await request(app.getHttpServer() as Server)
      .patch(`/api/v1/leads/${leadId}/profile`)
      .set('Authorization', `Bearer ${salesToken}`)
      .send({
        gender: 'male',
        ageBand: '26-35',
        industry: 'IT',
        district: '禅城',
        purchaseDealer: 'XX 4S店',
      })
      .expect(200);
    void res;
    const detail = await request(app.getHttpServer() as Server)
      .get(`/api/v1/leads/${leadId}`)
      .set('Authorization', `Bearer ${salesToken}`)
      .expect(200);
    const body = detail.body as { gender?: string; ageBand?: string; industry?: string };
    expect(body.gender).toBe('male');
    expect(body.ageBand).toBe('26-35');
    expect(body.industry).toBe('IT');
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'lead.profile_updated', objectType: 'lead', objectId: leadId },
    });
    expect(audit).not.toBeNull();
  });

  it('枚举外值 400：gender=other / ageBand=30岁；五字段全空 400', async () => {
    const bad1 = await request(app.getHttpServer() as Server)
      .patch(`/api/v1/leads/${leadId}/profile`)
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ gender: 'other' });
    expect(bad1.status).toBe(400);
    const bad2 = await request(app.getHttpServer() as Server)
      .patch(`/api/v1/leads/${leadId}/profile`)
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ ageBand: '30岁' });
    expect(bad2.status).toBe(400);
    const empty = await request(app.getHttpServer() as Server)
      .patch(`/api/v1/leads/${leadId}/profile`)
      .set('Authorization', `Bearer ${salesToken}`)
      .send({});
    expect(empty.status).toBe(400);
  });

  it('recorder 无 m03:edit → 403；不存在客资 404', async () => {
    const denied = await request(app.getHttpServer() as Server)
      .patch(`/api/v1/leads/${leadId}/profile`)
      .set('Authorization', `Bearer ${recorderToken}`)
      .send({ gender: 'female' });
    expect(denied.status).toBe(403);
    const missing = await request(app.getHttpServer() as Server)
      .patch('/api/v1/leads/nonexistent/profile')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ gender: 'female' });
    expect(missing.status).toBe(404);
  });

  it('导入行 schema：五个中文表头映射画像字段，枚举空值通过、非空须命中', () => {
    // HEADER_MAP/ImportRowSchema 顶部静态导入（vitest 对动态相对导入要求 .js 扩展）
    expect(HEADER_MAP['客户性别']).toBe('gender');
    expect(HEADER_MAP['年龄段']).toBe('ageBand');
    expect(HEADER_MAP['行业']).toBe('industry');
    expect(HEADER_MAP['住所方位']).toBe('district');
    expect(HEADER_MAP['购车门店']).toBe('purchaseDealer');
    // schema 键为英文字段名（HEADER_MAP 负责中文表头→键），必填项 productNeed/sourceCategory
    const ok = ImportRowSchema.safeParse({
      sourceCategory: '线下',
      sourcePlatform: 'x',
      productNeed: '车衣',
      phone: '13800000001',
      gender: '男',
      ageBand: '26-35',
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.gender).toBe('male');
    const bad = ImportRowSchema.safeParse({
      sourceCategory: '线下',
      sourcePlatform: 'x',
      productNeed: '车衣',
      phone: '13800000002',
      gender: '未知',
    });
    expect(bad.success).toBe(false);
  });
});
