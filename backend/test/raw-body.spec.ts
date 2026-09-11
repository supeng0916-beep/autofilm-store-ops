import type { INestApplication } from '@nestjs/common';
import { Controller, Post, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupApp } from '../src/common/setup-app';

interface ProbeBody {
  raw: string | null;
  body: unknown;
}

/** 探针控制器：回显 setupApp verify 钩子捕获的原始请求体 */
@Controller('raw-probe')
class RawProbeController {
  @Post()
  handle(@Req() req: Request): ProbeBody {
    return { raw: req.rawBody ? req.rawBody.toString('utf8') : null, body: req.body as unknown };
  }
}

describe('rawBody 捕获（P2-04 回调验签前置）', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [RawProbeController],
    }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST JSON：req.rawBody 保留原始字节，req.body 解析不受影响', async () => {
    const payload = '{"taskId":"t1","中文":"值"}';
    const res = await request(server)
      .post('/api/v1/raw-probe')
      .set('content-type', 'application/json')
      .send(payload);
    expect(res.status).toBe(201);
    const body = res.body as ProbeBody;
    expect(body).toEqual({ raw: payload, body: JSON.parse(payload) as unknown });
  });

  it('无 content-type 的 POST：body parser 跳过，rawBody 缺省，请求不受影响', async () => {
    const res = await request(server).post('/api/v1/raw-probe');
    expect(res.status).toBe(201);
    const body = res.body as ProbeBody;
    expect(body.raw).toBeNull();
  });
});
