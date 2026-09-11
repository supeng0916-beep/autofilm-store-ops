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
import { AiCostService } from '../src/modules/ai-dispatch/ai-cost.service';
import { AiDispatchService } from '../src/modules/ai-dispatch/ai-dispatch.service';
import { AI_TASK_STATUS } from '../src/modules/ai-dispatch/ai-dispatch.states';
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
// 必须用 vi.hoisted 抢在导入前注入密钥，process.env 才能优先于 backend/.env 的开发值生效。
// 数据库连接串由 test/test-env-setup.ts（setupFiles）在导入前统一指向测试库。
const CALLBACK_SECRET = vi.hoisted(() => {
  const secret = 'test-only-callback-0000000000000000';
  process.env.WG_AI_CALLBACK_SECRET = secret;
  return secret;
});

/** 假网关：提交即成功（done）、健康恒真，保证 hello 端点同步闭环可达 done（同 ai-callback.spec 手法） */
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

/** 独立实例的 ConfigService 覆盖：仅改写指定键，其余透传 process.env（同 ai-switch.spec 手法）。
 * 用数值覆盖而非改 process.env：共享测试库下多个实例并存，进程级环境变量会互相污染。 */
function configOverride(overrides: Record<string, number>) {
  return {
    get: (key: string, fallback?: unknown) => overrides[key] ?? process.env[key] ?? fallback,
  };
}

/** 停掉独立实例的定时任务：预算用例只走直连断言，不赌定时器（同 ai-switch.spec 手法） */
function stopCronJobs(app: INestApplication): void {
  for (const job of app.get(SchedulerRegistry).getCronJobs().values()) void job.stop();
}

/** 构建带 ConfigService 覆盖的独立 app 实例（共享同一测试库与 JWT 密钥，令牌通用） */
async function buildIsolatedApp(overrides: Record<string, number>): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(OPENCLAW_GATEWAY)
    .useValue(new FakeGateway())
    .overrideProvider(ConfigService)
    .useValue(configOverride(overrides))
    .compile();
  const isolated = mod.createNestApplication();
  setupApp(isolated);
  await isolated.init();
  stopCronJobs(isolated);
  return isolated;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 本地日期键（YYYY-MM-DD）：SystemMeta 提额/去重键的日期段 */
function todayKey(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

interface TaskBody {
  id: string;
  status: string;
}
interface CostDayRow {
  date: string;
  taskCount: number;
  tokensIn: number;
  tokensOut: number;
  costFen: number;
}
interface ErrorBody {
  code: string;
  detail: { spentFen?: number; budgetFen?: number } | null;
}
interface BudgetStatusBody {
  date: string;
  spentFen: number;
  budgetFen: number;
  warnFen: number;
  alertFen: number;
}
interface BreakdownRow {
  date: string;
  model: string;
  taskType: string;
  taskCount: number;
  tokensIn: number;
  tokensOut: number;
  costFen: number;
}

describe('AI 成本统计与日预算限额（P2-06）', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let service: AiDispatchService;
  let repo: AiTaskRepository;
  let bossToken = '';
  let managerToken = '';
  let salesToken = '';
  let recorderToken = '';
  let sysAdminToken = '';
  const password = 'S3cure-Passw0rd!';
  // 测试隔离：本套件创建/插入的任务行统一登记，afterAll 全量清理——
  // 共享测试库下带 costEstimateFen 的行会进入「当日预算」口径，不得残留污染其他套件
  const createdTaskIds: string[] = [];

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
    service = app.get(AiDispatchService);
    repo = app.get(AiTaskRepository);

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
    bossToken = await createUser('boss', 'aicost_boss'); // 有 ai:cost:view + approval:view
    managerToken = await createUser('store_manager', 'aicost_mgr'); // 仅 m10:view，无 ai:cost:view
    salesToken = await createUser('sales_ops', 'aicost_sales'); // 有 approval:view，无系统特权
    recorderToken = await createUser('recorder', 'aicost_rec'); // 无 ai:cost:view
    sysAdminToken = await createUser('sys_admin', 'aicost_admin'); // 有 ai:cost:view（集成监控）
  });

  afterAll(async () => {
    // 先清事件子表再清任务行（同库其他套件不依赖这些行，本套件自产自销）
    await prisma.aiTaskEvent.deleteMany({ where: { taskId: { in: createdTaskIds } } });
    await prisma.aiTask.deleteMany({ where: { id: { in: createdTaskIds } } });
    await app.close();
  });

  const helloPost = (srv: Server, token: string) =>
    request(srv)
      .post('/api/v1/ai/tasks/hello')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '成本测试' });

  /** 直落一条 dispatched 任务（绕过 submitTask 同步闭环），专测回调端点触发的成本记账 */
  const createDispatchedTask = async (): Promise<string> => {
    const created = await repo.create({ taskType: 'hello', inputSummary: '{"name":"成本测试"}' });
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

  /** 回调投递：rawBody 逐字节签名，走真实 HTTP（同 ai-callback.spec 手法）。
   * srv 可选独立实例：token cap 等配置断言必须让受理 app 与覆盖配置同源 */
  const postCallback = (taskId: string, body: unknown, srv: Server = server) => {
    const raw = JSON.stringify(body);
    return request(srv)
      .post(`/api/v1/internal/ai-callback/${taskId}`)
      .set('content-type', 'application/json')
      .set('x-wg-signature', signHmac(CALLBACK_SECRET, raw))
      .send(raw);
  };

  it('预算=0 完全停用：hello 拒收 429 AI_BUDGET_EXCEEDED；业务审批 CRUD 不受影响', async () => {
    const isolated = await buildIsolatedApp({ WG_AI_DAILY_BUDGET_FEN: 0 });
    try {
      const blocked = await helloPost(isolated.getHttpServer() as Server, salesToken);
      expect(blocked.status).toBe(429);
      expect((blocked.body as ErrorBody).code).toBe('AI_BUDGET_EXCEEDED');
      // 预算=0 是合法「完全停用」配置：spent≥0 恒触发；spent 精确值受共享库历史影响只断言预算线
      expect((blocked.body as ErrorBody).detail).toMatchObject({ budgetFen: 0 });

      // 熔断线只挡 AI 提交：同 token 调业务审批列表仍 200
      const crud = await request(isolated.getHttpServer() as Server)
        .get('/api/v1/approvals')
        .set('Authorization', `Bearer ${salesToken}`);
      expect(crud.status).toBe(200);
    } finally {
      await isolated.close();
    }
  });

  it('成本累计触发熔断：两笔 6 分成本后（预算 10 分），新提交 429', async () => {
    // 共享库当日可能已有其他套件的任务行（costEstimateFen 为空不计入），
    // 预算取 baseline+10 保证断言只对本用例插入的 12 分成本敏感
    const agg = await prisma.aiTask.aggregate({
      _sum: { costEstimateFen: true },
      where: { createdAt: { gte: startOfToday() } },
    });
    const baseline = agg._sum.costEstimateFen ?? 0;
    const isolated = await buildIsolatedApp({ WG_AI_DAILY_BUDGET_FEN: baseline + 10 });
    try {
      const srv = isolated.getHttpServer() as Server;
      // 预算尚有余量：第一笔提交正常受理（discharged → dispatched）
      const first = await helloPost(srv, salesToken);
      expect(first.status).toBe(201);
      createdTaskIds.push((first.body as TaskBody).id);

      // arrange：两笔已完成任务各 6 分（直插，模拟当日已落账成本）
      for (const cost of [6, 6]) {
        const row = await prisma.aiTask.create({
          data: { taskType: 'hello', inputSummary: '{"arrange":"cost"}', costEstimateFen: cost },
        });
        createdTaskIds.push(row.id);
      }

      // 当日已耗 baseline+12 ≥ 预算 baseline+10 → 拒收
      const blocked = await helloPost(srv, salesToken);
      expect(blocked.status).toBe(429);
      expect((blocked.body as ErrorBody).code).toBe('AI_BUDGET_EXCEEDED');
    } finally {
      await isolated.close();
    }
  });

  it('usage 落库：done 回调带 usage/model/cost → 任务行三字段齐全', async () => {
    const taskId = await createDispatchedTask();
    createdTaskIds.push(taskId);

    const res = await postCallback(taskId, {
      taskType: 'hello',
      status: 'done',
      output: { greeting: '你好' },
      usage: { tokensIn: 10, tokensOut: 20 },
      model: 'echo',
      costEstimateFen: 3,
    });
    expect(res.status).toBe(200);

    const row = await prisma.aiTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe(AI_TASK_STATUS.DONE);
    expect(row.tokensIn).toBe(10);
    expect(row.tokensOut).toBe(20);
    expect(row.model).toBe('echo');
    expect(row.costEstimateFen).toBe(3);
  });

  it('2026-08-28 P5：网关未报金额 → 按单价表估算成本；模型无单价如实留空', async () => {
    // MiniMax-M3 默认单价：输入 210 分/百万、输出 420 分/百万 → 100万入+50万出 = 210+210 = 420 分
    const taskId = await createDispatchedTask();
    createdTaskIds.push(taskId);
    const res = await postCallback(taskId, {
      taskType: 'hello',
      status: 'done',
      output: { greeting: '你好' },
      usage: { tokensIn: 1_000_000, tokensOut: 500_000 },
      model: 'MiniMax-M3',
    });
    expect(res.status).toBe(200);
    const row = await prisma.aiTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.costEstimateFen).toBe(420);

    // 未知模型无单价 → 成本留空（不估 0 冒充真实）
    const unknownId = await createDispatchedTask();
    createdTaskIds.push(unknownId);
    const res2 = await postCallback(unknownId, {
      taskType: 'hello',
      status: 'done',
      output: { greeting: '你好' },
      usage: { tokensIn: 1_000_000, tokensOut: 500_000 },
      model: 'some-unknown-model',
    });
    expect(res2.status).toBe(200);
    const row2 = await prisma.aiTask.findUniqueOrThrow({ where: { id: unknownId } });
    expect(row2.costEstimateFen).toBeNull();
  });

  it('无 usage 仍写 model/cost：failed 回调不带 usage 但带 model/cost → 两字段落库（P2 终审 triage）', async () => {
    const taskId = await createDispatchedTask();
    createdTaskIds.push(taskId);

    const res = await postCallback(taskId, {
      taskType: 'hello',
      status: 'failed',
      errorMessage: '模型超时',
      model: 'echo',
      costEstimateFen: 5,
    });
    expect(res.status).toBe(200);

    const row = await prisma.aiTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(row.status).toBe(AI_TASK_STATUS.FAILED);
    expect(row.tokensIn).toBeNull(); // 无 usage 不写 token
    expect(row.tokensOut).toBeNull();
    expect(row.model).toBe('echo');
    expect(row.costEstimateFen).toBe(5);
  });

  it('token 超限只告警不拒收：60 > cap 50，任务仍 done，审计 ai.task.token_cap_exceeded', async () => {
    const isolated = await buildIsolatedApp({ WG_AI_TASK_MAX_TOKENS: 50 });
    try {
      const srv = isolated.getHttpServer() as Server;
      const taskId = await createDispatchedTask();
      createdTaskIds.push(taskId);

      // 回调必须走独立实例：token cap 判定读的是受理 app 的 ConfigService（cap=50）
      const res = await postCallback(
        taskId,
        {
          taskType: 'hello',
          status: 'done',
          output: { greeting: '你好' },
          usage: { tokensIn: 40, tokensOut: 20 }, // 合计 60 > 50
          model: 'echo',
        },
        srv,
      );
      expect(res.status).toBe(200);

      // 结果已产出 → 不拒收：任务照常 done
      const row = await prisma.aiTask.findUniqueOrThrow({ where: { id: taskId } });
      expect(row.status).toBe(AI_TASK_STATUS.DONE);
      expect(row.tokensIn).toBe(40);
      expect(row.tokensOut).toBe(20);

      const audits = await prisma.auditLog.findMany({
        where: { action: 'ai.task.token_cap_exceeded', objectType: 'ai_task', objectId: taskId },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].after).toEqual({ tokens: 60, cap: 50 });
    } finally {
      await isolated.close();
    }
  });

  it('日报聚合：当日任务数/token/成本合计正确；recorder 无 ai:cost:view → 403', async () => {
    const dailyGet = (token: string, qs = '') =>
      request(server).get(`/api/v1/ai/costs/daily${qs}`).set('Authorization', `Bearer ${token}`);

    // 基线：共享库当日残留会随套件运行累积，findSince 的 take:1000 截断会让差值断言饱和失效
    // （2026-08-17 实测积累 1000+ 触发），故先清当日行再取基线（文件串行执行，无并发写入）
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    await prisma.aiTask.deleteMany({ where: { createdAt: { gte: startOfToday } } });
    const base = await dailyGet(bossToken, '?days=1');
    expect(base.status).toBe(200);
    expect(base.body as CostDayRow[]).toHaveLength(1);
    const todayKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
    expect((base.body as CostDayRow[])[0].date).toBe(todayKey);
    const before = (base.body as CostDayRow[])[0];

    // arrange：当日两笔任务（一笔有成本，一笔仅 token）
    const rowA = await prisma.aiTask.create({
      data: {
        taskType: 'hello',
        inputSummary: '{"arrange":"daily-A"}',
        tokensIn: 10,
        tokensOut: 20,
        costEstimateFen: 3,
      },
    });
    const rowB = await prisma.aiTask.create({
      data: {
        taskType: 'hello',
        inputSummary: '{"arrange":"daily-B"}',
        tokensIn: 5,
        tokensOut: 5,
        costEstimateFen: 2,
      },
    });
    createdTaskIds.push(rowA.id, rowB.id);

    const after = await dailyGet(bossToken, '?days=1');
    expect(after.status).toBe(200);
    const row = (after.body as CostDayRow[])[0];
    expect(row.taskCount).toBe(before.taskCount + 2);
    expect(row.tokensIn).toBe(before.tokensIn + 15);
    expect(row.tokensOut).toBe(before.tokensOut + 25);
    expect(row.costFen).toBe(before.costFen + 5);

    // days 缺省默认 7
    const week = await dailyGet(bossToken);
    expect(week.status).toBe(200);
    expect(week.body as CostDayRow[]).toHaveLength(7);

    // 鉴权：recorder 无 ai:cost:view → 403；匿名 → 401
    const denied = await dailyGet(recorderToken, '?days=1');
    expect(denied.status).toBe(403);
    expect((denied.body as ErrorBody).code).toBe('PERM_DENIED');
    const anon = await request(server).get('/api/v1/ai/costs/daily');
    expect(anon.status).toBe(401);
  });

  it('成本可见性收窄（2026-08-13 矩阵变更）：boss/sys_admin 200，store_manager 403', async () => {
    const dailyGet = (token: string) =>
      request(server).get('/api/v1/ai/costs/daily?days=1').set('Authorization', `Bearer ${token}`);

    // boss：经营视野可见成本（矩阵 AI通道成本行）
    const boss = await dailyGet(bossToken);
    expect(boss.status).toBe(200);

    // sys_admin：成本属集成监控可见（矩阵 AI通道成本行）
    const admin = await dailyGet(sysAdminToken);
    expect(admin.status).toBe(200);

    // store_manager：仅持 m10:view（业务分析），不再授予本端点 → 403（收窄证据）
    const manager = await dailyGet(managerToken);
    expect(manager.status).toBe(403);
    expect((manager.body as ErrorBody).code).toBe('PERM_DENIED');
  });

  it('breakdown 按日期×模型×任务类型聚合', async () => {
    // 清场：共享库当日残留行可能与造数同 taskType/model，聚合断言需精确
    // （同「日报聚合」用例手法；文件串行执行，无并发写入）
    await prisma.aiTask.deleteMany({ where: { createdAt: { gte: startOfToday() } } });

    // 造当日两条任务：model=MiniMax-M3 taskType=hello cost 100；model=MiniMax-M3 taskType=knowledge.search cost 200
    const rowA = await prisma.aiTask.create({
      data: {
        taskType: 'hello',
        model: 'MiniMax-M3',
        inputSummary: '{"arrange":"breakdown-A"}',
        costEstimateFen: 100,
      },
    });
    const rowB = await prisma.aiTask.create({
      data: {
        taskType: 'knowledge.search',
        model: 'MiniMax-M3',
        inputSummary: '{"arrange":"breakdown-B"}',
        costEstimateFen: 200,
      },
    });
    createdTaskIds.push(rowA.id, rowB.id);

    const rows = await app.get(AiCostService).breakdown(1);
    const hit = rows.find((r) => r.taskType === 'knowledge.search');
    expect(hit?.costFen).toBe(200);
    const hello = rows.find((r) => r.taskType === 'hello');
    expect(hello).toMatchObject({ model: 'MiniMax-M3', taskCount: 1, costFen: 100 });

    // 端点 + 鉴权：boss 200（数组），recorder 无 ai:cost:view → 403
    const ok = await request(server)
      .get('/api/v1/ai/costs/breakdown?days=1')
      .set('Authorization', `Bearer ${bossToken}`);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body)).toBe(true);
    expect(
      (ok.body as BreakdownRow[]).find((r) => r.taskType === 'knowledge.search')?.costFen,
    ).toBe(200);
    const denied = await request(server)
      .get('/api/v1/ai/costs/breakdown?days=1')
      .set('Authorization', `Bearer ${recorderToken}`);
    expect(denied.status).toBe(403);
    expect((denied.body as ErrorBody).code).toBe('PERM_DENIED');
  });

  it('breakdown null model 归 unknown，同日 costFen 倒序、跨日日期倒序，token 聚合', async () => {
    // 清场：断言覆盖全部返回行的顺序与数量，窗口内（今昨两日）不得有残留行
    const yesterday = new Date(startOfToday());
    yesterday.setDate(yesterday.getDate() - 1);
    await prisma.aiTask.deleteMany({ where: { createdAt: { gte: yesterday } } });

    // 昨日一行：cost 故意高于当日次高行，验证「日期倒序」优先于「costFen 倒序」
    const rowY = await prisma.aiTask.create({
      data: {
        taskType: 'hello',
        model: 'MiniMax-M3',
        inputSummary: '{"arrange":"breakdown-yesterday"}',
        costEstimateFen: 999,
        createdAt: (() => {
          const d = new Date(yesterday);
          d.setHours(12, 0, 0, 0);
          return d;
        })(),
      },
    });
    // 当日三行：两条 model=null 同组（验证 token/计数聚合），一条 model 有值且 cost 最高
    const rowN1 = await prisma.aiTask.create({
      data: {
        taskType: 'hello',
        inputSummary: '{"arrange":"breakdown-null-1"}',
        costEstimateFen: 10,
        tokensIn: 7,
        tokensOut: 3,
      },
    });
    const rowN2 = await prisma.aiTask.create({
      data: {
        taskType: 'hello',
        inputSummary: '{"arrange":"breakdown-null-2"}',
        costEstimateFen: 20,
        tokensIn: 1,
        tokensOut: 2,
      },
    });
    const rowM = await prisma.aiTask.create({
      data: {
        taskType: 'hello',
        model: 'MiniMax-M3',
        inputSummary: '{"arrange":"breakdown-model"}',
        costEstimateFen: 300,
        tokensIn: 100,
        tokensOut: 50,
      },
    });
    createdTaskIds.push(rowY.id, rowN1.id, rowN2.id, rowM.id);

    const rows = await app.get(AiCostService).breakdown(2);
    expect(rows).toHaveLength(3);
    // 顺序：当日在前（日期倒序），当日内 costFen 倒序（300 → 30），昨日行最后（cost 999 更高也不前移）
    const todayStr = todayKey();
    expect(rows[0]).toMatchObject({ date: todayStr, model: 'MiniMax-M3', costFen: 300 });
    // null-model 组：model 归 'unknown'，两条任务的 token/计数聚合
    expect(rows[1]).toMatchObject({
      date: todayStr,
      model: 'unknown',
      taskCount: 2,
      tokensIn: 8,
      tokensOut: 5,
      costFen: 30,
    });
    const yd = new Date();
    yd.setDate(yd.getDate() - 1);
    const yesterdayStr = `${yd.getFullYear()}-${String(yd.getMonth() + 1).padStart(2, '0')}-${String(yd.getDate()).padStart(2, '0')}`;
    expect(rows[2]).toMatchObject({ date: yesterdayStr, model: 'MiniMax-M3', costFen: 999 });
  });

  it('跨 60% 触发提醒且当日只发一次（v1.5 注意事项 6 梯度通知）', { timeout: 30_000 }, async () => {
    const dateKey = todayKey();
    const noteStart = new Date();
    const dedupKeys = [`ai_cost_notified:warn:${dateKey}`, `ai_cost_notified:alert:${dateKey}`];
    const isolated = await buildIsolatedApp({ WG_AI_DAILY_BUDGET_FEN: 10000 });
    try {
      // 清场：共享测试库可能残留前轮的去重键与通知行，不清则「只发一次」断言失真
      await prisma.systemMeta.deleteMany({ where: { key: { in: dedupKeys } } });
      await prisma.notification.deleteMany({ where: { kind: 'ai_budget_warn' } });

      // arrange：当日成本 6100 分（跨 60%=6000 线、未达 80%=8000 线；共享库残留成本只会抬高 spent，不影响跨线判定）
      const row = await prisma.aiTask.create({
        data: {
          taskType: 'hello',
          inputSummary: '{"arrange":"budget-warn"}',
          costEstimateFen: 6100,
        },
      });
      createdTaskIds.push(row.id);

      // notifyRoleHolders 按角色群发：共享测试库历史积累的 boss 用户数即单次触发条数，
      // 「只发一次」断言口径 = 第二次调用后条数不增长（而非绝对 1 条）
      const bossCount = await prisma.userRole.count({
        where: { role: { code: 'boss' }, user: { disabled: false } },
      });
      expect(bossCount).toBeGreaterThan(0);

      const warnNotes = () =>
        prisma.notification
          .findMany({ where: { kind: 'ai_budget_warn', createdAt: { gte: noteStart } } })
          .then((rows) => rows.filter((n) => n.title.includes('60')));

      const costs = isolated.get(AiCostService);
      await costs.checkBudgetNotify();
      const first = await warnNotes();
      expect(first).toHaveLength(bossCount);
      expect(first[0].body).toContain('预算 100.00 元');

      await costs.checkBudgetNotify(); // 第二次必须被 SystemMeta 去重键挡下，不得重发
      expect(await warnNotes()).toHaveLength(bossCount);

      // 去重键落库（重启不重发的依据）
      expect(await prisma.systemMeta.findUnique({ where: { key: dedupKeys[0] } })).not.toBeNull();
    } finally {
      await isolated.close();
      await prisma.systemMeta.deleteMany({ where: { key: { in: dedupKeys } } });
      await prisma.notification.deleteMany({ where: { kind: 'ai_budget_warn' } });
    }
  });

  // 群发规模随共享测试库 boss 用户累积膨胀（踩坑实录 #8，2026-08-26 达 4k+ 行拖超默认 5s）：
  // 时限放宽到 30s；库膨胀时按需清 users（套件均自建用户，roles 保留）
  it(
    '并发双跨档仍只发一次：去重键原子认领消除 read-then-write 竞态（修复轮 1）',
    { timeout: 30_000 },
    async () => {
      const dateKey = todayKey();
      const noteStart = new Date();
      const dedupKeys = [`ai_cost_notified:warn:${dateKey}`, `ai_cost_notified:alert:${dateKey}`];
      const isolated = await buildIsolatedApp({ WG_AI_DAILY_BUDGET_FEN: 10000 });
      try {
        await prisma.systemMeta.deleteMany({ where: { key: { in: dedupKeys } } });
        await prisma.notification.deleteMany({ where: { kind: 'ai_budget_warn' } });
        // 只跨 warn 档（6000 ≤ spent < 8000）：清掉当日成本行后精确落 6100
        await prisma.aiTask.deleteMany({ where: { createdAt: { gte: startOfToday() } } });
        const row = await prisma.aiTask.create({
          data: {
            taskType: 'hello',
            inputSummary: '{"arrange":"budget-warn-race"}',
            costEstimateFen: 6100,
          },
        });
        createdTaskIds.push(row.id);

        const bossCount = await prisma.userRole.count({
          where: { role: { code: 'boss' }, user: { disabled: false } },
        });
        expect(bossCount).toBeGreaterThan(0);
        const warnNotes = () =>
          prisma.notification
            .findMany({ where: { kind: 'ai_budget_warn', createdAt: { gte: noteStart } } })
            .then((rows) => rows.filter((n) => n.title.includes('60')));

        // 原子原语直测：首次认领 true，同键再次认领必须 false（P2002 冲突兜回）——
        // 本地单连接环境 Promise.all 竞态难稳定复现，原语断言提供确定性覆盖
        const claimKey = `ai_cost_notified:warn:claim-probe-${dateKey}`;
        const raceRepo = isolated.get(AiTaskRepository);
        expect(await raceRepo.metaTryClaim(claimKey)).toBe(true);
        expect(await raceRepo.metaTryClaim(claimKey)).toBe(false);
        await prisma.systemMeta.delete({ where: { key: claimKey } });

        const costs = isolated.get(AiCostService);
        // 模拟双回调几乎同时跨档：read-then-write 非原子时两者皆读 null → 双发（2×bossCount）；
        // 原子认领后仅一方落键成功，条数恰为 bossCount
        await Promise.all([costs.checkBudgetNotify(), costs.checkBudgetNotify()]);
        expect(await warnNotes()).toHaveLength(bossCount);

        await costs.checkBudgetNotify(); // 后续串行调用同样被去重键挡下
        expect(await warnNotes()).toHaveLength(bossCount);
      } finally {
        await isolated.close();
        await prisma.systemMeta.deleteMany({ where: { key: { in: dedupKeys } } });
        await prisma.notification.deleteMany({ where: { kind: 'ai_budget_warn' } });
      }
    },
  );

  it('临时提额当日生效、触顶按新额度判定（v1.5 注意事项 6）', async () => {
    const dateKey = todayKey();
    const overrideKey = `ai_budget_override:${dateKey}`;
    const agg = await prisma.aiTask.aggregate({
      _sum: { costEstimateFen: true },
      where: { createdAt: { gte: startOfToday() } },
    });
    const baseline = agg._sum.costEstimateFen ?? 0;
    const isolated = await buildIsolatedApp({ WG_AI_DAILY_BUDGET_FEN: baseline + 10 });
    try {
      const srv = isolated.getHttpServer() as Server;
      await prisma.systemMeta.deleteMany({ where: { key: overrideKey } });

      // arrange：12 分成本 > env 预算 baseline+10 → 触顶 429
      const row = await prisma.aiTask.create({
        data: { taskType: 'hello', inputSummary: '{"arrange":"override"}', costEstimateFen: 12 },
      });
      createdTaskIds.push(row.id);
      const blocked = await helloPost(srv, salesToken);
      expect(blocked.status).toBe(429);
      expect((blocked.body as ErrorBody).code).toBe('AI_BUDGET_EXCEEDED');

      // 非 boss 提额 → 403（服务层角色硬校验，sys_admin 也不行）
      const denied = await request(srv)
        .post('/api/v1/ai/costs/daily-budget')
        .set('Authorization', `Bearer ${sysAdminToken}`)
        .send({ budgetFen: baseline + 100000 });
      expect(denied.status).toBe(403);
      expect((denied.body as ErrorBody).code).toBe('PERM_DENIED');

      // boss 提额 → 200；status 口径切到新额度
      const ok = await request(srv)
        .post('/api/v1/ai/costs/daily-budget')
        .set('Authorization', `Bearer ${bossToken}`)
        .send({ budgetFen: baseline + 100000 });
      expect(ok.status).toBe(200);

      const status = await request(srv)
        .get('/api/v1/ai/costs/status')
        .set('Authorization', `Bearer ${bossToken}`);
      expect(status.status).toBe(200);
      expect(status.body as BudgetStatusBody).toMatchObject({
        date: dateKey,
        budgetFen: baseline + 100000,
        warnFen: Math.round((baseline + 100000) * 0.6),
        alertFen: Math.round((baseline + 100000) * 0.8),
      });

      // 触顶按新额度判定：成本不变，重新提交受理 201（次日 key 变化自动回落，无清理任务）
      const unblocked = await helloPost(srv, salesToken);
      expect(unblocked.status).toBe(201);
      createdTaskIds.push((unblocked.body as TaskBody).id);
    } finally {
      await isolated.close();
      await prisma.systemMeta.deleteMany({ where: { key: overrideKey } });
    }
  });
});
