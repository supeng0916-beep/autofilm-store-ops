import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 模板 17 列表头（与 import/row-schema.ts HEADER_MAP 列序一致） */
const HEADERS = [
  '来源大类',
  '来源平台',
  '运营主体',
  '获客方式',
  '上游派发NO/介绍人',
  '广告计划/活动原文',
  '内容标题/内容ID/链接',
  '上游聊天/原始信息链接',
  '客户称呼',
  '联系电话',
  '微信号',
  '微信号类型',
  '业务类型',
  '车型/住宅对象',
  '需求产品/服务',
  '客户原始需求',
  '备注',
];

interface PreviewBody {
  previewToken: string;
  rowCount: number;
  errorRows: { row: number; message: string }[];
}

interface ConfirmBody {
  batchId: string;
  created: number;
  dupCount: number;
  errors: { row: number; message: string }[];
}

interface ErrorBody {
  code: string;
}

let phoneSeq = 0;
function syntheticPhone(): string {
  const ts = String(Date.now()).slice(-7);
  const seq = String(phoneSeq++ % 10);
  return `138${ts}${seq}`;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function toCsv(rows: string[][]): string {
  return [HEADERS, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

function validRow(phone: string): string[] {
  return [
    '线上',
    '抖音',
    '品牌总部代运营',
    '广告私信',
    'D-1001',
    'AutoFilm Demo-测试素材',
    'content-1',
    'https://chat.example.com/1',
    '客户甲',
    phone,
    '',
    'real',
    'auto_film',
    '凯迪拉克XT5',
    '改色膜',
    '想贴改色膜',
    '测试备注',
  ];
}

/** 缺电话且缺微信的非法行（触发 refine「电话与微信至少填一项」） */
const INVALID_ROW = [
  '线下',
  '4S店',
  '门店自营',
  '4S店介绍',
  '',
  '',
  '',
  '',
  '客户乙',
  '',
  '',
  'unknown',
  'home_film',
  '别墅落地玻璃',
  '窗膜',
  '',
  '',
];

async function buildXlsx(rows: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('导入');
  for (const r of rows) sheet.addRow(r);
  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}

describe('P3-01 CSV/Excel 导入', () => {
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
    bossToken = (await mkUser(uniqueUsername('li_boss'), 'boss')).token;
    recorderToken = (await mkUser(uniqueUsername('li_recorder'), 'recorder')).token;
  });

  afterAll(async () => {
    await app.close();
  });

  it('合法 CSV 两阶段导入：预览返回行解析结果，确认后落库并生成 leadNo', async () => {
    const phone = syntheticPhone();
    const preview = await request(server)
      .post('/api/v1/leads/import/preview')
      .set('Authorization', `Bearer ${bossToken}`)
      .attach('file', Buffer.from(toCsv([validRow(phone)])), {
        filename: 'leads.csv',
        contentType: 'text/csv',
      });
    expect(preview.status).toBe(200);
    const pbody = preview.body as PreviewBody;
    expect(pbody.rowCount).toBe(1);
    expect(pbody.errorRows).toEqual([]);
    expect(pbody.previewToken).toBeTruthy();

    const confirm = await request(server)
      .post('/api/v1/leads/import/confirm')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ previewToken: pbody.previewToken });
    expect(confirm.status).toBe(200);
    expect((confirm.body as ConfirmBody).created).toBe(1);

    const lead = await prisma.lead.findFirst({ where: { phone } });
    expect(lead).not.toBeNull();
    expect(lead!.leadNo).toMatch(/^L-\d{8}-\d{4}$/);
    expect(lead!.sourceCategory).toBe('online');
  });

  it('错误行不阻断正确行：缺电话且缺微信的行计入 errorRows，其余正常入库', async () => {
    const phone = syntheticPhone();
    const preview = await request(server)
      .post('/api/v1/leads/import/preview')
      .set('Authorization', `Bearer ${bossToken}`)
      .attach('file', Buffer.from(toCsv([validRow(phone), INVALID_ROW])), {
        filename: 'leads.csv',
        contentType: 'text/csv',
      });
    expect(preview.status).toBe(200);
    const pbody = preview.body as PreviewBody;
    expect(pbody.rowCount).toBe(1);
    expect(pbody.errorRows).toHaveLength(1);
    expect(pbody.errorRows[0].message).toContain('电话与微信至少填一项');

    const confirm = await request(server)
      .post('/api/v1/leads/import/confirm')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ previewToken: pbody.previewToken });
    expect(confirm.status).toBe(200);
    expect((confirm.body as ConfirmBody).created).toBe(1);
    expect((confirm.body as ConfirmBody).errors).toHaveLength(1);

    expect(await prisma.lead.findFirst({ where: { phone } })).not.toBeNull();
  });

  it('同一文件二次提交被拒：409 LEAD_DUP_BATCH', async () => {
    const phone = syntheticPhone();
    const csv = toCsv([validRow(phone)]);
    const first = await request(server)
      .post('/api/v1/leads/import/preview')
      .set('Authorization', `Bearer ${bossToken}`)
      .attach('file', Buffer.from(csv), { filename: 'leads.csv', contentType: 'text/csv' });
    expect(first.status).toBe(200);
    const confirm = await request(server)
      .post('/api/v1/leads/import/confirm')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ previewToken: (first.body as PreviewBody).previewToken });
    expect(confirm.status).toBe(200);

    const again = await request(server)
      .post('/api/v1/leads/import/preview')
      .set('Authorization', `Bearer ${bossToken}`)
      .attach('file', Buffer.from(csv), { filename: 'leads.csv', contentType: 'text/csv' });
    expect(again.status).toBe(409);
    expect((again.body as ErrorBody).code).toBe('LEAD_DUP_BATCH');
  });

  it('chatLink 不泄漏进 preview/confirm 的 JSON 响应', async () => {
    const chatLink = `https://chat.example.com/secret-${Date.now()}`;
    const row = [
      '线上',
      '抖音',
      '',
      '',
      '',
      '',
      '',
      chatLink,
      '客户丙',
      '',
      '',
      'real',
      'auto_film',
      '',
      '改色膜',
      '',
      '',
    ];
    const preview = await request(server)
      .post('/api/v1/leads/import/preview')
      .set('Authorization', `Bearer ${bossToken}`)
      .attach('file', Buffer.from(toCsv([row])), {
        filename: 'leads.csv',
        contentType: 'text/csv',
      });
    expect(preview.status).toBe(200);
    const pbody = preview.body as PreviewBody;
    expect(pbody.rowCount).toBe(0);
    expect(pbody.errorRows).toHaveLength(1);
    expect(preview.text).not.toContain(chatLink);
    expect(JSON.stringify(pbody)).not.toContain(chatLink);

    const confirm = await request(server)
      .post('/api/v1/leads/import/confirm')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ previewToken: pbody.previewToken });
    expect(confirm.status).toBe(200);
    expect((confirm.body as ConfirmBody).errors).toHaveLength(1);
    expect(confirm.text).not.toContain(chatLink);
    expect(JSON.stringify(confirm.body)).not.toContain(chatLink);
  });

  it('Excel 文件同样可导入且错误行可导出', async () => {
    const phone = syntheticPhone();
    const xlsx = await buildXlsx([HEADERS, validRow(phone), INVALID_ROW]);
    const preview = await request(server)
      .post('/api/v1/leads/import/preview')
      .set('Authorization', `Bearer ${bossToken}`)
      .attach('file', xlsx, { filename: 'leads.xlsx', contentType: XLSX_MIME });
    expect(preview.status).toBe(200);
    const pbody = preview.body as PreviewBody;
    expect(pbody.rowCount).toBe(1);
    expect(pbody.errorRows).toHaveLength(1);

    const exported = await request(server)
      .get(`/api/v1/leads/import/error-export/${pbody.previewToken}`)
      .set('Authorization', `Bearer ${bossToken}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toContain('spreadsheetml');
    expect(Buffer.isBuffer(exported.body)).toBe(true);
    expect((exported.body as Buffer).length).toBeGreaterThan(0);

    const confirm = await request(server)
      .post('/api/v1/leads/import/confirm')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ previewToken: pbody.previewToken });
    expect(confirm.status).toBe(200);
    expect((confirm.body as ConfirmBody).created).toBe(1);
  });

  it('模板下载返回 xlsx 表头', async () => {
    const res = await request(server)
      .get('/api/v1/leads/import/template.xlsx')
      .set('Authorization', `Bearer ${bossToken}`)
      .buffer(true)
      .parse((resp, cb) => {
        const chunks: Buffer[] = [];
        resp.on('data', (c: Buffer) => chunks.push(c));
        resp.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect((res.body as Buffer).length).toBeGreaterThan(0);
  });

  it('previewToken 10 分钟过期后 confirm 返回 422', async () => {
    const phone = syntheticPhone();
    const preview = await request(server)
      .post('/api/v1/leads/import/preview')
      .set('Authorization', `Bearer ${bossToken}`)
      .attach('file', Buffer.from(toCsv([validRow(phone)])), {
        filename: 'leads.csv',
        contentType: 'text/csv',
      });
    expect(preview.status).toBe(200);
    const token = (preview.body as PreviewBody).previewToken;

    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockReturnValue(realNow() + 11 * 60 * 1000);
    try {
      const confirm = await request(server)
        .post('/api/v1/leads/import/confirm')
        .set('Authorization', `Bearer ${bossToken}`)
        .send({ previewToken: token });
      expect(confirm.status).toBe(422);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('无 m03:edit 权限（recorder）导入被拒 403', async () => {
    const res = await request(server)
      .post('/api/v1/leads/import/preview')
      .set('Authorization', `Bearer ${recorderToken}`)
      .attach('file', Buffer.from(toCsv([validRow(syntheticPhone())])), {
        filename: 'leads.csv',
        contentType: 'text/csv',
      });
    expect(res.status).toBe(403);
    expect((res.body as ErrorBody).code).toBe('PERM_DENIED');
  });
});
