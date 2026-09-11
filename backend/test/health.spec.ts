import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';

import { buildApp } from './setup';

interface HealthBody {
  status: string;
  app: string;
  env: string;
  version?: string;
  buildTime?: string | null;
  startedAt?: string;
}

describe('GET /api/v1/health（P0-02）', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('返回 ok 与运行环境', async () => {
    const res = await request(app.getHttpServer() as Server).get('/api/v1/health');
    const body = res.body as HealthBody;
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.app).toBe('autofilm-store-ops');
  });

  it('附带版本信息（2026-08-27：客户报障先对版本）', async () => {
    const res = await request(app.getHttpServer() as Server).get('/api/v1/health');
    const body = res.body as HealthBody;
    expect(res.status).toBe(200);
    expect(body.version).toBeTruthy(); // 读取 backend/package.json（发版人工递增）
    expect(body.startedAt).toBeTruthy();
  });

  it('未知路由返回结构化 404', async () => {
    const res = await request(app.getHttpServer() as Server).get('/api/v1/no-such-route');
    const body = res.body as { code: string };
    expect(res.status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
  });
});
