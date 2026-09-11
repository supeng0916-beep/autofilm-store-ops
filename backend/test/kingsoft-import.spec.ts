import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { uniqueUsername } from './helpers/unique';
import { buildApp } from './setup';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('P3-01 金山反馈表导入', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let auth: AuthService;
  let bossToken = '';
  let recorderToken = '';
  const password = 'S3cure-Passw0rd!';

  const mkUser = async (uname: string, role: string): Promise<{ token: string }> => {
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
    const user = await prisma.user.create({
      data: {
        username: uname,
        passwordHash: await auth.hashPassword(password),
        displayName: uname,
      },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ username: uname, password });
    return { token: (res.body as { accessToken: string }).accessToken };
  };

  beforeAll(async () => {
    app = await buildApp();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    bossToken = (await mkUser(uniqueUsername('ks_boss'), 'boss')).token;
    recorderToken = (await mkUser(uniqueUsername('ks_recorder'), 'recorder')).token;
  });

  afterAll(async () => {
    await app.close();
  });

  function dispatchText(dispatchNo: string): string {
    return [
      `派发NO：${dispatchNo}`,
      '门店：AutoFilm Demo',
      '日期：2026-08-14 10:20',
      '信息来源：抖音私信',
      '电话：13900000003',
      '微信：ewm-2468027890（虚拟二维码微信号）',
      '车型：凯迪拉克XT5',
      '需求：隐形车衣',
    ].join('\n');
  }

  async function buildKingsoftXlsx(rows: (string | number)[][]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('金山反馈');
    for (const r of rows) sheet.addRow(r);
    return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
  }

  it('金山表回填 hqFeedbackStatus 与成交金额，未匹配行计错误且不改 finalStatus', async () => {
    const dispatchNo = `KS-${Date.now()}`;
    const dispatch = await request(server)
      .post('/api/v1/leads/import/dispatch')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ rawTexts: [dispatchText(dispatchNo)] });
    expect(dispatch.status).toBe(200);
    expect((dispatch.body as { created: number }).created).toBe(1);

    const before = await prisma.lead.findFirst({ where: { upstreamDispatchNo: dispatchNo } });
    expect(before).not.toBeNull();
    expect(before!.finalStatus).toBe('active');

    const xlsx = await buildKingsoftXlsx([
      ['派发NO', '总部反馈状态', '成交金额', '成交日期'],
      [dispatchNo, '已反馈跟进中', 12000, ''],
      ['KS-UNMATCHED', '已反馈跟进中', '', ''],
    ]);
    const kingsoft = await request(server)
      .post('/api/v1/leads/import/kingsoft')
      .set('Authorization', `Bearer ${bossToken}`)
      .attach('file', xlsx, { filename: 'kingsoft.xlsx', contentType: XLSX_MIME });
    expect(kingsoft.status).toBe(200);
    const kbody = kingsoft.body as { matched: number; errors: { row: number; message: string }[] };
    expect(kbody.matched).toBe(1);
    expect(kbody.errors).toHaveLength(1);
    expect(kbody.errors[0].message).toContain('KS-UNMATCHED');

    const after = await prisma.lead.findFirst({ where: { upstreamDispatchNo: dispatchNo } });
    expect(after!.hqFeedbackStatus).toBe('已反馈跟进中');
    expect(after!.closedAmountFen).toBe(1200000);
    expect(after!.finalStatus).toBe('active');
  });

  it('无 m03:edit 权限（recorder）导入金山表被拒 403', async () => {
    const xlsx = await buildKingsoftXlsx([
      ['派发NO', '总部反馈状态', '成交金额', '成交日期'],
      ['KS-X', '已反馈跟进中', '', ''],
    ]);
    const res = await request(server)
      .post('/api/v1/leads/import/kingsoft')
      .set('Authorization', `Bearer ${recorderToken}`)
      .attach('file', xlsx, { filename: 'kingsoft.xlsx', contentType: XLSX_MIME });
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('PERM_DENIED');
  });
});
