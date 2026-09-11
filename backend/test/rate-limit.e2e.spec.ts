/** 全站限流（快修批次）：低配上限下连续请求触发 429；默认配置不干扰常规流量。
 * 环境变量必须用 vi.hoisted 抢先设置——ConfigModule 在 AppModule 导入时即求值。 */
import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from './setup';

vi.hoisted(() => {
  process.env.WG_RATE_LIMIT_TTL = '60';
  process.env.WG_RATE_LIMIT_MAX = '3';
});

describe('全站限流', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('同一来源超过窗口上限返回 429', async () => {
    for (let i = 0; i < 3; i += 1) {
      const ok = await request(app.getHttpServer() as Server).get('/api/v1/health');
      expect(ok.status).toBe(200);
    }
    const blocked = await request(app.getHttpServer() as Server).get('/api/v1/health');
    expect(blocked.status).toBe(429);
  });
});
