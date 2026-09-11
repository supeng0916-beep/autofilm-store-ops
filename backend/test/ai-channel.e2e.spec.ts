import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { setupApp } from '../src/common/setup-app';
import { AI_TASK_STATUS } from '../src/modules/ai-dispatch/ai-dispatch.states';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  startFakeOpenClawGateway,
  type FakeOpenClawGatewayOptions,
} from './helpers/fake-openclaw-gateway';
import { uniqueUsername } from './helpers/unique';

/** 数值型配置键（与 common/config/env.schema.ts 的 z.coerce.number 键一一对应）：
 * @nestjs/config v4 的 validate 会把校验结果按字符串回写 process.env，
 * 透传前必须还原为 number，避免「WG_AI_DISPATCH_DEADLINE_S * 1000」之类的字符串拼接错值 */
const NUMERIC_ENV_KEYS = new Set([
  'WG_PORT',
  'WG_AI_DAILY_BUDGET_FEN',
  'WG_AI_TASK_MAX_TOKENS',
  'WG_AI_SUBMIT_TIMEOUT_MS',
  'WG_AI_DISPATCH_DEADLINE_S',
]);

/** 记录式活配置：覆盖键读记录，其余透传 process.env。
 * 与单测的本质区别：OPENCLAW_GATEWAY 不 override——真实 WsOpenClawGateway 的
 * 连接/鉴权/发起 run/等结果全程被验证；配置覆盖只承担「导入时不可知的运行时值」注入。 */
function liveConfigFor(record: Record<string, string | number>) {
  return {
    get: (key: string, fallback?: unknown) => {
      const raw = record[key] ?? process.env[key] ?? fallback;
      if (NUMERIC_ENV_KEYS.has(key) && typeof raw === 'string' && raw !== '') {
        const num = Number(raw);
        if (Number.isFinite(num)) return num;
      }
      return raw;
    },
  };
}

/** 停掉测试 app 的定时任务：健康/超时 cron 直调服务方法测试，不赌定时器 */
function stopCronJobs(app: INestApplication): void {
  for (const job of app.get(SchedulerRegistry).getCronJobs().values()) void job.stop();
}

interface TaskBody {
  id: string;
  status: string;
  errorMessage: string | null;
}
interface SwitchBody {
  global: boolean;
  skills: { taskType: string; enabled: boolean }[];
}
interface ErrorBody {
  code: string;
  detail: { reason?: string; budgetFen?: number } | null;
}

/** fake 替身成功回显（token 之外的可变行为：bad-schema 用例改写 fakeOpts.onRun 后恢复此值） */
const SUCCESS_RUN: NonNullable<FakeOpenClawGatewayOptions['onRun']> = () => ({
  output: { greeting: '你好（fake）', model: 'fake' },
  usage: { tokensIn: 11, tokensOut: 22 },
  model: 'fake',
  costEstimateFen: 2,
});

describe('AI 通道全链路（P3-00：Gateway WebSocket+RPC 同步闭环 e2e）', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let userToken = '';
  let adminToken = '';
  let opsToken = '';
  const password = 'S3cure-Passw0rd!';
  // 主实例运行时配置：fake 随机 WS 地址/ token 在 beforeAll 补齐（见 liveConfigFor 注释）
  const runtimeConfig: Record<string, string | number> = {};
  const createdTaskIds: string[] = [];
  const fakeOpts: FakeOpenClawGatewayOptions = { token: 'e2e-token', onRun: SUCCESS_RUN };
  let fake: Awaited<ReturnType<typeof startFakeOpenClawGateway>>;

  beforeAll(async () => {
    // 真实 WsOpenClawGateway 在模块工厂 boot 时经 ConfigService 固化 url/token，
    // fake 必须先于建 app 启动并写入 runtimeConfig（否则工厂拿到空 url → 通道未配置）
    fake = await startFakeOpenClawGateway(fakeOpts);
    runtimeConfig.WG_OPENCLAW_GATEWAY_WS_URL = fake.url;
    runtimeConfig.WG_OPENCLAW_GATEWAY_TOKEN = 'e2e-token';
    runtimeConfig.WG_AI_DAILY_BUDGET_FEN = 1_000_000; // 预算宽松，只测通道闭环

    process.env.WG_JWT_SECRET ??= 'test-only-secret-0246802789abcdef!!';
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(liveConfigFor(runtimeConfig))
      .compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    stopCronJobs(app);
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);

    const auth = app.get(AuthService);
    const createUser = async (roleCode: string, prefix: string): Promise<string> => {
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
      return (login.body as { accessToken: string }).accessToken;
    };
    userToken = await createUser('recorder', 'aie2e_user'); // hello 仅需认证，无权限点要求
    adminToken = await createUser('sys_admin', 'aie2e_admin'); // system:manage（开关）
    opsToken = await createUser('sales_ops', 'aie2e_ops'); // approval:view（审批列表）
  });

  afterAll(async () => {
    // 开关恢复缺省（删除即视为开启），避免污染共享测试库其他套件
    await prisma.systemMeta.deleteMany({
      where: { key: { in: ['ai.global.enabled', 'ai.skill.hello.enabled'] } },
    });
    await prisma.aiTaskEvent.deleteMany({ where: { taskId: { in: createdTaskIds } } });
    await prisma.aiTask.deleteMany({ where: { id: { in: createdTaskIds } } });
    await fake.close();
    await app.close();
  });

  const helloPost = (srv: Server, token: string) =>
    request(srv)
      .post('/api/v1/ai/tasks/hello')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '回环测试' });

  const putSwitch = (token: string, body: Record<string, unknown>) =>
    request(server).put('/api/v1/ai/switches').set('Authorization', `Bearer ${token}`).send(body);

  const eventsOf = (taskId: string) =>
    prisma.aiTaskEvent.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });
  const auditsOf = (taskId: string, action?: string) =>
    prisma.auditLog.findMany({
      where: { objectType: 'ai_task', objectId: taskId, ...(action ? { action } : {}) },
      orderBy: { createdAt: 'asc' },
    });

  it('全链路全通：提交 → WS 连接鉴权 → agent → 等结果 → 校验 → done 落库', async () => {
    const res = await helloPost(server, userToken);
    expect(res.status).toBe(201);
    const body = res.body as TaskBody;
    createdTaskIds.push(body.id);
    expect(body.status).toBe(AI_TASK_STATUS.DONE);

    // agent RPC 契约：idempotencyKey=taskId、message 为字符串（P3-00 协议依据）
    expect(fake.received).toHaveLength(1);
    const agentParams = fake.received[0] as { message?: unknown; idempotencyKey?: unknown };
    expect(agentParams.idempotencyKey).toBe(body.id);
    expect(typeof agentParams.message).toBe('string');

    const row = await prisma.aiTask.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.output).toEqual({ greeting: '你好（fake）', model: 'fake' });
    expect(row.tokensIn).toBe(11);
    expect(row.tokensOut).toBe(22);
    expect(row.model).toBe('fake');
    expect(row.costEstimateFen).toBe(2);

    expect((await eventsOf(body.id)).map((e) => e.toStatus)).toEqual([
      'pending',
      'dispatched',
      'callback_received',
      'validated',
      'done',
    ]);
    expect((await auditsOf(body.id)).map((a) => a.action)).toContain('ai.task.done');
  });

  it('bad-schema 输出降级：WS 返回不合契约 output → degraded + 审计 schema_rejected', async () => {
    fakeOpts.onRun = () => ({ output: {} }); // 缺 greeting → HelloOutputSchema 校验失败
    try {
      const res = await helloPost(server, userToken);
      expect(res.status).toBe(201);
      const body = res.body as TaskBody;
      createdTaskIds.push(body.id);
      expect(body.status).toBe(AI_TASK_STATUS.DEGRADED);
      expect(body.errorMessage).toContain('输出校验失败');

      expect(await auditsOf(body.id, 'ai.callback.schema_rejected')).toHaveLength(1);
    } finally {
      fakeOpts.onRun = SUCCESS_RUN;
    }
  });

  it('断链自动降级且不阻塞业务：WS 连接重试耗尽 → degraded，审批/健康端点照常 200', async () => {
    // 独立实例指向死端口：真实 WsOpenClawGateway 连接重试耗尽（≤3 次退避）→ submitTask 降级
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(
        liveConfigFor({
          WG_OPENCLAW_GATEWAY_WS_URL: 'ws://127.0.0.1:1',
          WG_OPENCLAW_GATEWAY_TOKEN: 'e2e-token',
        }),
      )
      .compile();
    const isolated = mod.createNestApplication();
    setupApp(isolated);
    await isolated.init();
    stopCronJobs(isolated);
    try {
      const srv = isolated.getHttpServer() as Server;
      const res = await helloPost(srv, userToken);
      expect(res.status).toBe(201);
      const body = res.body as TaskBody;
      createdTaskIds.push(body.id);
      expect(body.status).toBe(AI_TASK_STATUS.DEGRADED);
      expect(body.errorMessage).toContain('提交失败');

      // 「AI 故障永不阻塞核心业务」实证：同实例上业务端点照常
      const approvals = await request(srv)
        .get('/api/v1/approvals')
        .set('Authorization', `Bearer ${opsToken}`);
      expect(approvals.status).toBe(200);
      const healthRes = await request(srv).get('/api/v1/health');
      expect(healthRes.status).toBe(200);
    } finally {
      await isolated.close();
    }
  });

  it('停止开关实测有效：关全局 → hello 503 AI_DISABLED；开启即恢复提交', async () => {
    const off = await putSwitch(adminToken, { scope: 'global', enabled: false, confirmed: true });
    expect(off.status).toBe(200);
    expect((off.body as SwitchBody).global).toBe(false);

    const blocked = await helloPost(server, userToken);
    expect(blocked.status).toBe(503);
    expect((blocked.body as ErrorBody).code).toBe('AI_DISABLED');
    expect((blocked.body as ErrorBody).detail).toEqual({ reason: 'switch' });

    const on = await putSwitch(adminToken, { scope: 'global', enabled: true, confirmed: true });
    expect(on.status).toBe(200);
    expect((on.body as SwitchBody).global).toBe(true);

    const ok = await helloPost(server, userToken);
    expect(ok.status).toBe(201);
    createdTaskIds.push((ok.body as TaskBody).id);
    expect((ok.body as TaskBody).status).toBe(AI_TASK_STATUS.DONE);
  });

  it('预算闸门：budget=0 → hello 429 AI_BUDGET_EXCEEDED，审批 CRUD 不受影响', async () => {
    // 独立实例（budget=0）不动主实例配置：ConfigService 记录覆盖，OPENCLAW_GATEWAY 不覆盖。
    // 门禁顺序为开关→预算：通道配置须齐全（test-env-setup 已注入假 WS 地址），否则先撞 not_configured
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(liveConfigFor({ WG_AI_DAILY_BUDGET_FEN: 0 }))
      .compile();
    const isolated = mod.createNestApplication();
    setupApp(isolated);
    await isolated.init();
    stopCronJobs(isolated);
    try {
      const srv = isolated.getHttpServer() as Server;
      const blocked = await helloPost(srv, userToken);
      expect(blocked.status).toBe(429);
      expect((blocked.body as ErrorBody).code).toBe('AI_BUDGET_EXCEEDED');
      expect((blocked.body as ErrorBody).detail).toMatchObject({ budgetFen: 0 });

      // 熔断线只挡 AI 提交：同库同 token 的业务审批列表照常 200
      const crud = await request(srv)
        .get('/api/v1/approvals')
        .set('Authorization', `Bearer ${opsToken}`);
      expect(crud.status).toBe(200);
    } finally {
      await isolated.close();
    }
  });
});
