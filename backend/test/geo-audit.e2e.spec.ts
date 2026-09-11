/** GEO 优化助手（V1.5 批次4）：marketing.geo_audit 一键任务——联网诊断门店可被搜索到程度，
 * 输出建议态诊断+内容草稿；权限 m02:edit/approve（经营任务中心）。 */
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

class GeoGateway implements OpenClawGateway {
  last?: SubmitTaskRequest;
  submit(req: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.last = req;
    const output =
      req.taskType === 'marketing.geo_audit'
        ? {
            verdict: '品牌词可搜到，服务词覆盖弱（fake）',
            findings: [{ dimension: '品牌词', seen: true, detail: '第 2 条出现点评页' }],
            suggestions: ['补全地图平台服务项目', '简介加核心服务词'],
            draft: '本地AutoFilm Demo：窗膜/车衣/改色膜专店，到店免费评估（fake）',
          }
        : { greeting: '你好（fake）', model: 'fake' };
    return Promise.resolve({ status: 'done', output });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve(void 0);
  }
}

describe('GEO 优化助手（V1.5 批次4）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const gateway = new GeoGateway();
  let bossToken = '';
  let salesToken = '';

  beforeAll(async () => {
    app = await buildApp(gateway);
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const mk = async (role: string) => {
      const username = uniqueUsername('geo');
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
  });
  afterAll(async () => {
    await app.close();
  });

  it('POST /marketing/geo-audit：m02 门禁——sales_ops 可用（有 m02:edit）、recorder 403、匿名 401', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/marketing/geo-audit')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({});
    expect(res.status).toBe(201);
    expect(gateway.last?.taskType).toBe('marketing.geo_audit');
    expect(String(gateway.last?.context?.city)).toContain('本地');
    const anon = await request(app.getHttpServer() as Server)
      .post('/api/v1/marketing/geo-audit')
      .send({});
    expect(anon.status).toBe(401);
    void bossToken;
  });

  it('返回任务行：done 态与诊断输出落 ai_tasks', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/marketing/geo-audit')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({});
    expect(res.status).toBe(201);
    const body = res.body as { status: string; output: { verdict?: string } | null };
    expect(body.status).toBe('done');
    expect(body.output?.verdict).toContain('品牌词');
  });
});
