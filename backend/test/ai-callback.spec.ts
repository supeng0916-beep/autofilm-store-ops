import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { signHmac } from '../src/common/crypto/hmac';
import { setupApp } from '../src/common/setup-app';
import { AiTaskRegistry, HelloOutputSchema } from '../src/modules/ai-dispatch/ai-dispatch.registry';
import { AI_TASK_STATUS } from '../src/modules/ai-dispatch/ai-dispatch.states';
import { AiDispatchService } from '../src/modules/ai-dispatch/ai-dispatch.service';
import {
  OPENCLAW_GATEWAY,
  type GatewayRunResult,
  type OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import { AiTaskRepository } from '../src/modules/ai-dispatch/ai-task.repository';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { uniqueUsername } from './helpers/unique';

// ConfigModule.forRoot 在 AppModule 导入时即求值（早于 beforeAll），
// 必须用 vi.hoisted 抢在导入前注入密钥，process.env 才能优先于 backend/.env 的开发值生效
const CALLBACK_SECRET = vi.hoisted(() => {
  const secret = 'test-only-callback-0000000000000000';
  process.env.WG_AI_CALLBACK_SECRET = secret;
  return secret;
});
const WRONG_SECRET = 'wrong-secret-0246802789abcdef!!';

/** 假网关：提交即成功（done），保证 hello 端点同步闭环可达 done（同 ai-dispatch.spec 手法） */
class FakeGateway implements OpenClawGateway {
  /** 测试用例可覆写提交返回的 output（默认 hello 合法输出） */
  static outputPayload: unknown = { greeting: '你好' };
  submit(): Promise<GatewayRunResult> {
    return Promise.resolve({ status: 'done', output: FakeGateway.outputPayload });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

interface TaskBody {
  id: string;
  status: string;
  errorMessage: string | null;
}
interface CallbackResultBody {
  status: string;
  ignored?: boolean;
}
interface ErrorBody {
  code: string;
}

describe('AI 回调端点（P2-04：验签/按类型校验/幂等落库）', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let service: AiDispatchService;
  let repo: AiTaskRepository;
  let token = '';
  const password = 'S3cure-Passw0rd!';

  beforeAll(async () => {
    process.env.WG_JWT_SECRET ??= 'test-only-secret-0246802789abcdef!!';
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OPENCLAW_GATEWAY)
      .useValue(new FakeGateway())
      .compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    service = app.get(AiDispatchService);
    repo = app.get(AiTaskRepository);

    // 无 AI 权限点的普通登录用户（recorder）：hello 端点仅需认证
    await prisma.role.upsert({
      where: { code: 'recorder' },
      update: {},
      create: { code: 'recorder', name: 'recorder' },
    });
    const auth = app.get(AuthService);
    const uname = uniqueUsername('aicb_user');
    const user = await prisma.user.create({
      data: {
        username: uname,
        passwordHash: await auth.hashPassword(password),
        displayName: uname,
      },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'recorder' } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ username: uname, password });
    token = (login.body as { accessToken: string }).accessToken;
  });

  // 恢复假网关默认输出，避免用例间漂移污染（静态成员跨用例共享）
  afterEach(() => {
    FakeGateway.outputPayload = { greeting: '你好' };
  });

  afterAll(async () => {
    await app.close();
  });

  /** 直落一条 dispatched 任务（绕过 submitTask 同步闭环，专测回调端点）：返回 dispatched 态任务 */
  const createDispatchedTask = async (): Promise<TaskBody> => {
    const created = await repo.create({ taskType: 'hello', inputSummary: '{"name":"回调测试"}' });
    await repo.appendEvent(created.id, null, 'pending', 'created');
    const task = await service.transition(
      created.id,
      AI_TASK_STATUS.PENDING,
      AI_TASK_STATUS.DISPATCHED,
      undefined,
      { deadlineAt: new Date(), dispatchedAt: new Date() },
    );
    return { id: task.id, status: task.status, errorMessage: task.errorMessage };
  };

  /** 回调投递：rawBody 逐字节签名，走真实 HTTP（验签依赖 body parser 捕获的原始字节） */
  const postCallback = (
    taskId: string,
    body: unknown,
    overrides: { raw?: string; signature?: string } = {},
  ) => {
    const raw = overrides.raw ?? JSON.stringify(body);
    const signature = overrides.signature ?? signHmac(CALLBACK_SECRET, raw);
    return request(server)
      .post(`/api/v1/internal/ai-callback/${taskId}`)
      .set('content-type', 'application/json')
      .set('x-wg-signature', signature)
      .send(raw);
  };

  const eventsOf = (taskId: string) =>
    prisma.aiTaskEvent.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });
  const auditsOf = (taskId: string, action?: string) =>
    prisma.auditLog.findMany({
      where: { objectType: 'ai_task', objectId: taskId, ...(action ? { action } : {}) },
      orderBy: { createdAt: 'asc' },
    });

  it('合法回调：done 路径两次迁移，事件序列完整，审计 ai.task.done', async () => {
    const task = await createDispatchedTask();
    const envelope = {
      taskType: 'hello',
      status: 'done',
      output: { greeting: '你好' },
      model: 'test-model',
    };
    const res = await postCallback(task.id, envelope);
    expect(res.status).toBe(200);
    expect(res.body as CallbackResultBody).toEqual({ status: 'done', ignored: false });

    const row = await prisma.aiTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe(AI_TASK_STATUS.DONE);
    expect(row.callbackAt).toBeTruthy();
    expect(row.finishedAt).toBeTruthy();
    // 规格 §5.1：每任务必记录输出——校验通过的 output 与回调载荷一致
    expect(row.output).toEqual({ greeting: '你好' });

    const events = await eventsOf(task.id);
    expect(events.map((e) => e.toStatus)).toEqual([
      'pending',
      'dispatched',
      'callback_received',
      'validated',
      'done',
    ]);
    expect((await auditsOf(task.id)).map((a) => a.action)).toContain('ai.task.done');
  });

  it('normalize 钩子：漂移输出经确定性翻译后通过校验，任务 done（2026-08-21）', async () => {
    const registry = app.get(AiTaskRegistry);
    registry.register({
      taskType: 'test.normalize',
      skillName: 'skill-hello',
      outputSchema: HelloOutputSchema,
      normalize: (raw) => {
        const o = raw as Record<string, unknown>;
        return Array.isArray(o?.greeting) ? { greeting: o.greeting.join('') } : raw;
      },
    });
    FakeGateway.outputPayload = { greeting: ['你', '好'] }; // 漂移：数组而非字符串

    // hello 端点不支持任意 taskType：改走 submitTask 同步闭环（FakeGateway 返回漂移输出，
    // 经 applyEnvelope 同一校验路径），钩子在 schema 校验前确定性翻译
    const task = await service.submitTask('test.normalize', { name: '归一化钩子测试' });
    expect(task.status).toBe(AI_TASK_STATUS.DONE);

    const row = await prisma.aiTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe(AI_TASK_STATUS.DONE);
    // 落库 output 是归一后的字符串形态，而非原始数组漂移
    expect(row.output).toEqual({ greeting: '你好' });

    const events = await eventsOf(task.id);
    expect(events.map((e) => e.toStatus)).toEqual([
      'pending',
      'dispatched',
      'callback_received',
      'validated',
      'done',
    ]);
  });

  it('错误签名：401 AI_SIGNATURE_INVALID，任务维持 dispatched，拒收留痕', async () => {
    const task = await createDispatchedTask();
    const envelope = { taskType: 'hello', status: 'done', output: { greeting: '你好' } };
    const raw = JSON.stringify(envelope);
    const res = await postCallback(task.id, envelope, {
      signature: signHmac(WRONG_SECRET, raw),
    });
    expect(res.status).toBe(401);
    expect((res.body as ErrorBody).code).toBe('AI_SIGNATURE_INVALID');

    const row = await prisma.aiTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe(AI_TASK_STATUS.DISPATCHED);

    const audits = await auditsOf(task.id, 'ai.callback.rejected');
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toEqual({ reason: 'signature' });
  });

  it('信封 taskType 与任务记录不符：401 AI_SIGNATURE_INVALID，任务状态不变，审计拒收（P2 终审 triage）', async () => {
    const task = await createDispatchedTask();
    const envelope = { taskType: 'other', status: 'done', output: { greeting: '你好' } };
    const res = await postCallback(task.id, envelope);
    expect(res.status).toBe(401);
    expect((res.body as ErrorBody).code).toBe('AI_SIGNATURE_INVALID');

    // 内容不可信：不进入状态机，任务维持 dispatched，无回调事件
    const row = await prisma.aiTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe(AI_TASK_STATUS.DISPATCHED);
    expect(await eventsOf(task.id)).toHaveLength(2); // 仅 pending/dispatched

    const audits = await auditsOf(task.id, 'ai.callback.rejected');
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toMatchObject({ reason: 'taskType_mismatch' });
  });

  it('错误 output：422 拒收，任务降级并留痕（callback_received → degraded）', async () => {
    const task = await createDispatchedTask();
    // output 缺 greeting：HelloOutputSchema 校验失败
    const envelope = { taskType: 'hello', status: 'done', output: {} };
    const res = await postCallback(task.id, envelope);
    expect(res.status).toBe(422);
    expect((res.body as ErrorBody).code).toBe('VALIDATION_FAILED');

    const row = await prisma.aiTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe(AI_TASK_STATUS.DEGRADED);
    expect(row.errorMessage).toContain('输出校验失败');
    expect(row.finishedAt).toBeTruthy();

    const events = await eventsOf(task.id);
    expect(events.map((e) => e.toStatus)).toEqual([
      'pending',
      'dispatched',
      'callback_received',
      'degraded',
    ]);
    expect(await auditsOf(task.id, 'ai.callback.schema_rejected')).toHaveLength(1);
  });

  it('F06：schema 降级同样计量 usage（degraded 不再丢 token，phase12 成本口径缺口）', async () => {
    const task = await createDispatchedTask();
    // output 缺 greeting → 校验失败降级；信封带 usage/model → 模型已产出，成本必须落库
    const envelope = {
      taskType: 'hello',
      status: 'done',
      output: {},
      usage: { tokensIn: 1234, tokensOut: 56 },
      model: 'cb-test-model',
    };
    const res = await postCallback(task.id, envelope);
    expect(res.status).toBe(422);

    const row = await prisma.aiTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe(AI_TASK_STATUS.DEGRADED);
    expect(row.tokensIn).toBe(1234);
    expect(row.tokensOut).toBe(56);
    expect(row.model).toBe('cb-test-model');
  });

  it('错误信封：422 拒收，任务不受影响，审计 reason=schema', async () => {
    const task = await createDispatchedTask();
    const res = await postCallback(task.id, { status: 'weird' });
    expect(res.status).toBe(422);
    expect((res.body as ErrorBody).code).toBe('VALIDATION_FAILED');

    const row = await prisma.aiTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe(AI_TASK_STATUS.DISPATCHED);
    expect(await eventsOf(task.id)).toHaveLength(2); // 仅 pending/dispatched，无回调事件

    const audits = await auditsOf(task.id, 'ai.callback.rejected');
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toEqual({ reason: 'schema' });
  });

  it('重复回调：终态任务幂等返回 ignored:true，事件数不变（D-P2-8）', async () => {
    const task = await createDispatchedTask();
    const envelope = { taskType: 'hello', status: 'done', output: { greeting: '你好' } };
    const first = await postCallback(task.id, envelope);
    expect(first.status).toBe(200);
    const eventsBefore = await prisma.aiTaskEvent.count({ where: { taskId: task.id } });
    const auditsBefore = await prisma.auditLog.count({
      where: { objectType: 'ai_task', objectId: task.id },
    });

    const second = await postCallback(task.id, envelope);
    expect(second.status).toBe(200);
    expect(second.body as CallbackResultBody).toEqual({ status: 'done', ignored: true });

    expect(await prisma.aiTaskEvent.count({ where: { taskId: task.id } })).toBe(eventsBefore);
    expect(
      await prisma.auditLog.count({ where: { objectType: 'ai_task', objectId: task.id } }),
    ).toBe(auditsBefore);
  });

  it('超期回调：已被超时扫描降级的任务同样幂等拒收', async () => {
    const task = await createDispatchedTask();
    // 模拟超时扫描：dispatched → degraded（终态）
    await service.transition(
      task.id,
      AI_TASK_STATUS.DISPATCHED,
      AI_TASK_STATUS.DEGRADED,
      'timeout',
    );
    const envelope = { taskType: 'hello', status: 'done', output: { greeting: '你好' } };
    const res = await postCallback(task.id, envelope);
    expect(res.status).toBe(200);
    expect(res.body as CallbackResultBody).toEqual({ status: 'degraded', ignored: true });
  });

  it('failed 上报：任务 failed 且 errorMessage 落库，审计 ai.task.failed', async () => {
    const task = await createDispatchedTask();
    const envelope = { taskType: 'hello', status: 'failed', errorMessage: '模型超时' };
    const res = await postCallback(task.id, envelope);
    expect(res.status).toBe(200);
    expect(res.body as CallbackResultBody).toEqual({ status: 'failed', ignored: false });

    const row = await prisma.aiTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe(AI_TASK_STATUS.FAILED);
    expect(row.errorMessage).toBe('模型超时');
    expect(row.output).toBeNull(); // failed 路径无 output 可落
    expect(await auditsOf(task.id, 'ai.task.failed')).toHaveLength(1);
  });

  it('hello 端点：无权限点的普通登录用户可调；未登录 401（D-P2-10）', async () => {
    const ok = await request(server)
      .post('/api/v1/ai/tasks/hello')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '通道自测' });
    expect(ok.status).toBe(201);
    expect((ok.body as TaskBody).id).toBeTruthy();
    expect((ok.body as TaskBody).status).toBe(AI_TASK_STATUS.DONE);

    const anon = await request(server).post('/api/v1/ai/tasks/hello').send({ name: '匿名' });
    expect(anon.status).toBe(401);
    expect((anon.body as ErrorBody).code).toBe('UNAUTHORIZED');
  });
});
