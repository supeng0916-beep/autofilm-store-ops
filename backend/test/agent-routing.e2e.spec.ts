/** chat 路由（V1.5 Task5）：persona→taskType 映射、structuredContext 注入、FakeGateway 捕获提交。
 * 复用 asset.e2e 的自定义 FakeGateway 手法（记录 SubmitTaskRequest）。 */
import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import type {
  GatewayRunResult,
  OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import { PersonaService } from '../src/modules/agent/persona.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

const password = 'S3cure-Passw0rd!';

class CapturingGateway implements OpenClawGateway {
  last?: SubmitTaskRequest;
  submit(req: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.last = req;
    return Promise.resolve({ status: 'done', output: { reply: '（fake）收到' } });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve(void 0);
  }
}

describe('agent chat 分角色路由（V1.5）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let persona: PersonaService;
  const gateway = new CapturingGateway();

  beforeAll(async () => {
    app = await buildApp(gateway);
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    persona = app.get(PersonaService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
  });
  afterAll(async () => {
    await prisma.systemMeta.deleteMany({ where: { key: 'agent.persona.map' } });
    await app.close();
  });

  async function tokenOf(roles: string[]): Promise<{ token: string; id: string }> {
    const username = uniqueUsername('ar');
    const user = await prisma.user.create({
      data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
    });
    for (const code of roles) {
      const role = await prisma.role.findUniqueOrThrow({ where: { code } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    }
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username, password });
    return { token: (res.body as { accessToken: string }).accessToken, id: user.id };
  }

  async function chatAs(token: string, message = '今天有什么要我拍板的？') {
    gateway.last = undefined;
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/agent/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ message, history: [] });
    expect(res.status).toBe(201);
    // FakeGateway 同步完成 submitTask，直接取捕获的提交请求（as 破除属性窄化：await 边界后
    // TS 仍认为 gateway.last 是 undefined）
    return gateway.last as SubmitTaskRequest | undefined;
  }

  it('boss 角色 → boss.agent.chat 且注入 structuredContext（approvals 区块键）', async () => {
    const { token } = await tokenOf(['boss']);
    const req = await chatAs(token);
    expect(req?.taskType).toBe('boss.agent.chat');
    expect(String(req?.context?.structuredContext)).toContain('【approvals】');
    expect(req?.context?.persona).toBe('boss');
  });

  it('store_manager → manager.agent.chat 且含【appointments】区块', async () => {
    const { token } = await tokenOf(['store_manager']);
    const req = await chatAs(token, '今天排期有没有冲突？');
    expect(req?.taskType).toBe('manager.agent.chat');
    expect(String(req?.context?.structuredContext)).toContain('【appointments】');
    expect(req?.context?.persona).toBe('manager');
  });

  it('sales_ops / recorder → sales.agent.chat，无 structuredContext', async () => {
    const sales = await tokenOf(['sales_ops']);
    expect((await chatAs(sales.token, '帮我写个跟进话术'))?.taskType).toBe('sales.agent.chat');
    const recorder = await tokenOf(['recorder']);
    const req = await chatAs(recorder.token, '门店在哪里');
    expect(req?.taskType).toBe('sales.agent.chat');
    expect(req?.context?.persona).toBe('general');
    expect(req?.context?.structuredContext).toBeUndefined();
  });

  it('显式映射覆盖路由：sales_ops 账号映射 boss 后走 boss.agent.chat', async () => {
    const { token, id } = await tokenOf(['sales_ops']);
    await persona.setEntry(
      { sub: 'op', username: 'op', type: 'access' },
      { userId: id, persona: 'boss' },
    );
    const req = await chatAs(token);
    expect(req?.taskType).toBe('boss.agent.chat');
  });

  it('共享 constraints 注入：注册的 boundary 含产出物纪律关键词', async () => {
    const { token } = await tokenOf(['boss']);
    const req = await chatAs(token);
    expect(String(req?.constraints?.boundary)).toContain('建议');
    expect(String(req?.constraints?.boundary)).toContain('简体中文');
  });
});
