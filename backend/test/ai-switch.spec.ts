import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { signHmac } from '../src/common/crypto/hmac';
import { setupApp } from '../src/common/setup-app';
import { AI_TASK_STATUS } from '../src/modules/ai-dispatch/ai-dispatch.states';
import { AiDispatchService } from '../src/modules/ai-dispatch/ai-dispatch.service';
import { AiHealthService } from '../src/modules/ai-dispatch/ai-health.service';
import { AiTaskRepository } from '../src/modules/ai-dispatch/ai-task.repository';
import {
  OPENCLAW_GATEWAY,
  type GatewayRunResult,
  type OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
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

/** 假网关：提交即成功（done）、健康恒真，保证 hello 同步闭环可达 done 且 ai/status 健康 */
class FakeGateway implements OpenClawGateway {
  submit(): Promise<GatewayRunResult> {
    return Promise.resolve({ status: 'done', output: { greeting: '你好' } });
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
}
interface StatusBody {
  globalEnabled: boolean;
  healthy: boolean;
  skills: { taskType: string; enabled: boolean }[];
  notice: string | null;
}
interface SwitchBody {
  global: boolean;
  skills: { taskType: string; enabled: boolean }[];
}
interface ErrorBody {
  code: string;
  detail: { reason?: string } | null;
}

/** 停掉测试 app 的定时任务：开关/超时用例直调服务方法，不赌定时器；
 * 也防止本 app 的 cron 与测试 arrange 的过期限任务竞态（生产装配不改）。 */
function stopCronJobs(app: INestApplication): void {
  for (const job of app.get(SchedulerRegistry).getCronJobs().values()) void job.stop();
}

describe('AI 开关、健康检查与超时扫描（P2-05）', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let health: AiHealthService;
  let service: AiDispatchService;
  let repo: AiTaskRepository;
  let adminToken = '';
  let adminUserId = '';
  let salesOpsToken = '';
  let userToken = '';
  const password = 'S3cure-Passw0rd!';

  const helloPost = async (token: string) =>
    request(server)
      .post('/api/v1/ai/tasks/hello')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '开关测试' });

  const putSwitch = (token: string, body: Record<string, unknown>) =>
    request(server).put('/api/v1/ai/switches').set('Authorization', `Bearer ${token}`).send(body);

  /** 直落一条 dispatched 任务（绕过 submitTask 同步闭环），专测超时扫描 */
  const createDispatchedTask = async (): Promise<string> => {
    const created = await repo.create({ taskType: 'hello', inputSummary: '{}' });
    await repo.appendEvent(created.id, null, 'pending', 'created');
    const task = await service.transition(
      created.id,
      AI_TASK_STATUS.PENDING,
      AI_TASK_STATUS.DISPATCHED,
      undefined,
      { deadlineAt: new Date(), dispatchedAt: new Date() },
    );
    return task.id;
  };

  beforeAll(async () => {
    process.env.WG_JWT_SECRET ??= 'test-only-secret-0246802789abcdef!!';
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OPENCLAW_GATEWAY)
      .useValue(new FakeGateway())
      .compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    stopCronJobs(app);
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    health = app.get(AiHealthService);
    service = app.get(AiDispatchService);
    repo = app.get(AiTaskRepository);

    const auth = app.get(AuthService);
    const createUser = async (
      roleCode: string,
      prefix: string,
    ): Promise<{ id: string; token: string }> => {
      await prisma.role.upsert({
        where: { code: roleCode },
        update: {},
        create: { code: roleCode, name: roleCode },
      });
      const uname = uniqueUsername(prefix);
      const user = await prisma.user.create({
        data: {
          username: uname,
          passwordHash: await auth.hashPassword(password),
          displayName: uname,
        },
      });
      const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
      const login = await request(server)
        .post('/api/v1/auth/login')
        .send({ username: uname, password });
      return { id: user.id, token: (login.body as { accessToken: string }).accessToken };
    };
    const admin = await createUser('sys_admin', 'aisw_admin');
    adminUserId = admin.id;
    adminToken = admin.token;
    salesOpsToken = (await createUser('sales_ops', 'aisw_ops')).token;
    userToken = (await createUser('recorder', 'aisw_user')).token;
  });

  afterAll(async () => {
    // 开关是测试库全局状态：恢复缺省（删除即视为开启），避免干扰并行套件
    await prisma.systemMeta.deleteMany({
      where: { key: { in: ['ai.global.enabled', 'ai.skill.hello.enabled'] } },
    });
    await app.close();
  });

  it('全局开关关闭 → hello 503 AI_DISABLED；重新开启即时恢复提交', async () => {
    const off = await putSwitch(adminToken, { scope: 'global', enabled: false, confirmed: true });
    expect(off.status).toBe(200);
    expect((off.body as SwitchBody).global).toBe(false);

    const blocked = await helloPost(userToken);
    expect(blocked.status).toBe(503);
    expect((blocked.body as ErrorBody).code).toBe('AI_DISABLED');
    expect((blocked.body as ErrorBody).detail).toEqual({ reason: 'switch' });

    const on = await putSwitch(adminToken, { scope: 'global', enabled: true, confirmed: true });
    expect(on.status).toBe(200);
    expect((on.body as SwitchBody).global).toBe(true);

    const ok = await helloPost(userToken);
    expect(ok.status).toBe(201);
    expect((ok.body as TaskBody).status).toBe(AI_TASK_STATUS.DONE);
  });

  it('skill 开关关闭 hello → 503 detail.reason=switch；开启即恢复', async () => {
    const off = await putSwitch(adminToken, {
      scope: 'skill',
      taskType: 'hello',
      enabled: false,
      confirmed: true,
    });
    expect(off.status).toBe(200);

    const blocked = await helloPost(userToken);
    expect(blocked.status).toBe(503);
    expect((blocked.body as ErrorBody).code).toBe('AI_DISABLED');
    expect((blocked.body as ErrorBody).detail).toEqual({ reason: 'switch' });

    const on = await putSwitch(adminToken, {
      scope: 'skill',
      taskType: 'hello',
      enabled: true,
      confirmed: true,
    });
    expect(on.status).toBe(200);
    const ok = await helloPost(userToken);
    expect(ok.status).toBe(201);
  });

  it('scope=skill 缺 taskType → 422（DTO superRefine 显式校验，不再依赖非空断言）', async () => {
    const res = await putSwitch(adminToken, {
      scope: 'skill',
      enabled: false,
      confirmed: true,
    });
    expect([400, 422]).toContain(res.status); // 同 approval.spec 口径
    expect((res.body as ErrorBody).code).toBe('VALIDATION_FAILED');
  });

  it('开关变更写审计 ai.switch.changed（before/after 齐全）；无 system:manage → 403；缺 confirmed → 422', async () => {
    const res = await putSwitch(adminToken, { scope: 'global', enabled: false, confirmed: true });
    expect(res.status).toBe(200);
    const audits = await prisma.auditLog.findMany({
      where: {
        action: 'ai.switch.changed',
        objectType: 'ai_switch',
        objectId: 'ai.global.enabled',
      },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(adminUserId);
    expect(audits[0].before).toEqual({ enabled: true });
    expect(audits[0].after).toEqual({ enabled: false });
    // 恢复开启（后续用例依赖缺省态）
    await putSwitch(adminToken, { scope: 'global', enabled: true, confirmed: true });

    const denied = await putSwitch(salesOpsToken, {
      scope: 'global',
      enabled: false,
      confirmed: true,
    });
    expect(denied.status).toBe(403);
    expect((denied.body as ErrorBody).code).toBe('PERM_DENIED');

    const noConfirm = await putSwitch(adminToken, { scope: 'global', enabled: false });
    expect([400, 422]).toContain(noConfirm.status); // 同 approval.spec 口径
    expect((noConfirm.body as ErrorBody).code).toBe('VALIDATION_FAILED');
  });

  it('超时扫描：dispatched 过 deadline → degraded 并审计 ai.task.timeout，计数 1', async () => {
    // 先清历史残留：其他套件遗留的过限期任务会被本轮扫描正常降级，保证后续计数精确
    await health.scanOverdue(new Date());

    const taskId = await createDispatchedTask();
    // 测试 arrange：repo 无改 deadline 能力，直连 prisma 把截止时间拨到过去
    await prisma.aiTask.update({
      where: { id: taskId },
      data: { deadlineAt: new Date(Date.now() - 60_000) },
    });

    const count = await health.scanOverdue(new Date());
    expect(count).toBe(1);

    const row = await prisma.aiTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe(AI_TASK_STATUS.DEGRADED);
    expect(row.errorMessage).toContain('timeout');
    expect(row.finishedAt).toBeTruthy();

    const events = await prisma.aiTaskEvent.findMany({ where: { taskId } });
    const last = events[events.length - 1];
    expect(last.fromStatus).toBe(AI_TASK_STATUS.DISPATCHED);
    expect(last.toStatus).toBe(AI_TASK_STATUS.DEGRADED);
    expect(last.reason).toContain('timeout');

    const audits = await prisma.auditLog.findMany({
      where: { action: 'ai.task.timeout', objectType: 'ai_task', objectId: taskId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toEqual({ taskType: 'hello' });
  });

  it('超时扫描与回调竞态：任务先被回调推到 done，再 scanOverdue 返回 0 不抛错', async () => {
    // 同样先清历史残留，保证 count===0 断言不被其他套件的过限期任务干扰
    await health.scanOverdue(new Date());

    const taskId = await createDispatchedTask();
    // 回调先到：真实 HTTP + HMAC 签名走 done 路径（同 ai-callback.spec 手法）
    const envelope = {
      taskType: 'hello',
      status: 'done',
      output: { greeting: '你好' },
    };
    const raw = JSON.stringify(envelope);
    const cb = await request(server)
      .post(`/api/v1/internal/ai-callback/${taskId}`)
      .set('content-type', 'application/json')
      .set('x-wg-signature', signHmac(CALLBACK_SECRET, raw))
      .send(raw);
    expect(cb.status).toBe(200);
    const row = await prisma.aiTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe(AI_TASK_STATUS.DONE);

    // 扫描随后才到：done 任务不在 findDispatchedOverdue 命中集，返回 0 且不误伤
    const count = await health.scanOverdue(new Date());
    expect(count).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { action: 'ai.task.timeout', objectType: 'ai_task', objectId: taskId },
      }),
    ).toBe(0);
    const after = await prisma.aiTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(after.status).toBe(AI_TASK_STATUS.DONE);

    // 显式覆盖捕获分支：扫描读到 stale 行（读到后、迁移前任务已被回调推离 dispatched），
    // transition 抛 AI_TASK_INVALID_STATE → scanOverdue 捕获跳过，计数 0 不抛错
    const stale = vi.spyOn(repo, 'findDispatchedOverdue').mockResolvedValueOnce([after]);
    expect(await health.scanOverdue(new Date())).toBe(0);
    stale.mockRestore();
  });

  it('GET ai/status：任一登录用户可见；开关关闭时 notice 提示人工处理', async () => {
    const ok = await request(server)
      .get('/api/v1/ai/status')
      .set('Authorization', `Bearer ${userToken}`);
    expect(ok.status).toBe(200);
    expect((ok.body as StatusBody).globalEnabled).toBe(true);
    expect((ok.body as StatusBody).healthy).toBe(true);
    expect((ok.body as StatusBody).notice).toBeNull();
    // P3-05 起注册表新增 lead.summary（Task 11/12 还将追加），用包含断言而非精确等值防脆
    expect((ok.body as StatusBody).skills).toEqual(
      expect.arrayContaining([
        { taskType: 'hello', enabled: true },
        { taskType: 'lead.summary', enabled: true },
      ]),
    );

    await putSwitch(adminToken, { scope: 'global', enabled: false, confirmed: true });
    const down = await request(server)
      .get('/api/v1/ai/status')
      .set('Authorization', `Bearer ${userToken}`);
    expect(down.status).toBe(200);
    expect((down.body as StatusBody).globalEnabled).toBe(false);
    expect((down.body as StatusBody).notice).toBe('AI 暂不可用，请人工处理');

    await putSwitch(adminToken, { scope: 'global', enabled: true, confirmed: true });
    const restored = await request(server)
      .get('/api/v1/ai/status')
      .set('Authorization', `Bearer ${userToken}`);
    expect((restored.body as StatusBody).notice).toBeNull();

    const anon = await request(server).get('/api/v1/ai/status');
    expect(anon.status).toBe(401);
  });

  it('通道未配置：hello 503 detail.reason=not_configured（ConfigService 覆盖独立实例）', async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string, fallback?: unknown) =>
          key === 'WG_OPENCLAW_GATEWAY_WS_URL' ? undefined : (process.env[key] ?? fallback),
      })
      .compile();
    const app2 = mod.createNestApplication();
    setupApp(app2);
    await app2.init();
    stopCronJobs(app2);
    try {
      const res = await request(app2.getHttpServer() as Server)
        .post('/api/v1/ai/tasks/hello')
        .set('Authorization', `Bearer ${userToken}`) // 同一 JWT 密钥与用户库，令牌通用
        .send({ name: '未配置通道' });
      expect(res.status).toBe(503);
      expect((res.body as ErrorBody).code).toBe('AI_DISABLED');
      expect((res.body as ErrorBody).detail).toEqual({ reason: 'not_configured' });
    } finally {
      await app2.close();
    }
  });

  it('通道 token 未配置同样拒绝（P3 遗留回收：门禁不只查 WS URL）', async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string, fallback?: unknown) =>
          key === 'WG_OPENCLAW_GATEWAY_TOKEN' ? undefined : (process.env[key] ?? fallback),
      })
      .compile();
    const app2 = mod.createNestApplication();
    setupApp(app2);
    await app2.init();
    stopCronJobs(app2);
    try {
      const res = await request(app2.getHttpServer() as Server)
        .post('/api/v1/ai/tasks/hello')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'token 未配置' });
      expect(res.status).toBe(503);
      expect((res.body as ErrorBody).code).toBe('AI_DISABLED');
      expect((res.body as ErrorBody).detail).toEqual({ reason: 'not_configured' });
    } finally {
      await app2.close();
    }
  });
});
