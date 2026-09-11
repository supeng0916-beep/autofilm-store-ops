import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { setupApp } from '../src/common/setup-app';
import {
  AI_TASK_STATUS,
  canTransition,
  type AiTaskStatus,
} from '../src/modules/ai-dispatch/ai-dispatch.states';
import {
  OPENCLAW_GATEWAY,
  OpenClawTimeoutError,
  type GatewayRunResult,
  type OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import { AiDispatchService } from '../src/modules/ai-dispatch/ai-dispatch.service';
import { AiTaskRepository } from '../src/modules/ai-dispatch/ai-task.repository';
import { scanForLeaks } from '../src/modules/ai-dispatch/masker';
import { PrismaService } from '../src/prisma/prisma.service';

class FakeGateway implements OpenClawGateway {
  submitted: SubmitTaskRequest[] = [];
  failNext = false;
  timeoutNext = false;
  submit(request: SubmitTaskRequest): Promise<GatewayRunResult> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('fake network down'));
    }
    if (this.timeoutNext) {
      this.timeoutNext = false;
      return Promise.reject(new OpenClawTimeoutError());
    }
    this.submitted.push(request);
    return Promise.resolve({ status: 'done', output: { greeting: '你好（fake）', model: 'fake' } });
  }
  health(): Promise<boolean> {
    return Promise.resolve(!this.failNext);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** 独立期望迁移表（逐字来自规格 §5.1 的字面量 oracle）。
 * 不用实现的 AI_TASK_TRANSITIONS 自证——迁移表写错时本表仍能抓出差异。 */
const EXPECTED_TRANSITIONS: Record<AiTaskStatus, readonly AiTaskStatus[]> = {
  [AI_TASK_STATUS.PENDING]: ['dispatched', 'cancelled', 'degraded'],
  [AI_TASK_STATUS.DISPATCHED]: ['running', 'callback_received', 'failed', 'degraded'],
  [AI_TASK_STATUS.RUNNING]: ['callback_received', 'failed', 'degraded'],
  // callback_received → failed：2026-09-04 M02 阶段一 Task2 新增——postLint hard 违规
  // （广告法极限词/英文泄漏）在 outputSchema 校验后拦截，语义与网关上报失败一致（可重试）
  [AI_TASK_STATUS.CALLBACK_RECEIVED]: ['validated', 'degraded', 'failed'],
  [AI_TASK_STATUS.VALIDATED]: ['done'],
  [AI_TASK_STATUS.FAILED]: ['degraded'],
  [AI_TASK_STATUS.DONE]: [],
  [AI_TASK_STATUS.TIMEOUT]: [],
  [AI_TASK_STATUS.DEGRADED]: [],
  [AI_TASK_STATUS.CANCELLED]: [],
};

describe('ai-dispatch 状态机（P2-01）', () => {
  const ALL = Object.values(AI_TASK_STATUS);

  it('oracle 表覆盖全部状态（防漏态导致参数化静默缺行）', () => {
    expect(Object.keys(EXPECTED_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  // 全迁移表参数化：合法对通过，非法对拒绝（终态 × 任意目标必拒）
  for (const from of ALL) {
    for (const to of ALL) {
      const allowed = EXPECTED_TRANSITIONS[from].includes(to);
      it(`${from} → ${to} ${allowed ? '合法' : '非法'}`, () => {
        expect(canTransition(from, to)).toBe(allowed);
      });
    }
  }
});

describe('submitTask（P2-01）', () => {
  let service: AiDispatchService;
  let repo: AiTaskRepository;
  let gateway: FakeGateway;
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.WG_JWT_SECRET ??= 'test-only-secret-0246802789abcdef!!';
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OPENCLAW_GATEWAY)
      .useValue(new FakeGateway())
      .compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    service = app.get(AiDispatchService);
    repo = app.get(AiTaskRepository);
    gateway = app.get(OPENCLAW_GATEWAY);
    prisma = app.get(PrismaService);
  });

  // 每个用例重置 FakeGateway，消除跨用例累积依赖（submitted 计数不依赖执行顺序）
  beforeEach(() => {
    gateway.submitted = [];
    gateway.failNext = false;
    gateway.timeoutNext = false;
  });

  /** 直落一条 dispatched 任务（绕过 submitTask 同步闭环），专测 transition 的迁移语义 */
  const createDispatchedTask = async (): Promise<
    Awaited<ReturnType<AiDispatchService['transition']>>
  > => {
    const created = await repo.create({ taskType: 'hello', inputSummary: '{}' });
    await repo.appendEvent(created.id, null, 'pending', 'created');
    return service.transition(
      created.id,
      AI_TASK_STATUS.PENDING,
      AI_TASK_STATUS.DISPATCHED,
      undefined,
      { deadlineAt: new Date(), dispatchedAt: new Date() },
    );
  };

  it('成功提交（同步闭环）：pending → dispatched → callback_received → validated → done，事件历史完整', async () => {
    const task = await service.submitTask('hello', { name: '测试' });
    expect(task.status).toBe(AI_TASK_STATUS.DONE);
    expect(task.deadlineAt).toBeTruthy();
    expect(task.dispatchedAt).toBeTruthy();
    expect(task.callbackAt).toBeTruthy();
    expect(task.finishedAt).toBeTruthy();
    const events = await repo.findEvents(task.id);
    expect(events.map((e) => e.toStatus)).toEqual([
      'pending',
      'dispatched',
      'callback_received',
      'validated',
      'done',
    ]);
    expect(gateway.submitted).toHaveLength(1);
  });

  it('提交失败：dispatched → degraded（不抛错，事件链 pending→dispatched→degraded）', async () => {
    gateway.failNext = true;
    const task = await service.submitTask('hello', { name: '测试' });
    expect(task.status).toBe(AI_TASK_STATUS.DEGRADED);
    expect(task.errorMessage).toContain('提交失败');
    expect(task.finishedAt).toBeTruthy();
    // 迁移前置（P2 终审 triage）：提交失败也先落 dispatched 再降级，事件链三段而非 pending 直降
    const events = await repo.findEvents(task.id);
    expect(events.map((e) => e.toStatus)).toEqual(['pending', 'dispatched', 'degraded']);
  });

  it('run 超时：gateway 抛 OpenClawTimeoutError → degraded(reason 含 timeout，审计 ai.task.timeout)', async () => {
    gateway.timeoutNext = true;
    const task = await service.submitTask('hello', { name: '超时' });
    expect(task.status).toBe(AI_TASK_STATUS.DEGRADED);
    expect(task.errorMessage).toContain('timeout');
    expect(task.finishedAt).toBeTruthy();
    const events = await repo.findEvents(task.id);
    expect(events.map((e) => e.toStatus)).toEqual(['pending', 'dispatched', 'degraded']);

    const audits = await prisma.auditLog.findMany({
      where: { action: 'ai.task.timeout', objectType: 'ai_task', objectId: task.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toEqual({ taskType: 'hello' });
  });

  it('含手机号上下文：gateway 收到无明文敏感信息（A04）', async () => {
    const task = await service.submitTask('hello', {
      customerPhone: '13800138000',
      note: '可在 13924680278 联系到车主',
    });
    expect(task.status).toBe(AI_TASK_STATUS.DONE);
    expect(gateway.submitted).toHaveLength(1);
    // P2-03 常设断言：提交请求体无明文敏感字段
    expect(scanForLeaks(gateway.submitted[0])).toEqual([]);
    expect(task.inputSummary).not.toContain('13800138000');
    expect(task.inputSummary).not.toContain('13924680278');
    expect(task.inputSummary).toContain('[PHONE]');
  });

  it('未注册 taskType：VALIDATION_FAILED', async () => {
    await expect(service.submitTask('nope', {})).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('中段迁移不清空累积时间戳：dispatched → callback_received 后 deadlineAt/dispatchedAt 仍在', async () => {
    const task = await createDispatchedTask();
    expect(task.deadlineAt).toBeTruthy();
    expect(task.dispatchedAt).toBeTruthy();
    const mid = await service.transition(
      task.id,
      AI_TASK_STATUS.DISPATCHED,
      AI_TASK_STATUS.CALLBACK_RECEIVED,
      undefined,
      { callbackAt: new Date() },
    );
    expect(mid.deadlineAt).toBeTruthy();
    expect(mid.dispatchedAt).toBeTruthy();
    expect(mid.callbackAt).toBeTruthy();
  });

  it('合法迁移对但任务已离开 from 态（count=0 竞态分支）：AI_TASK_INVALID_STATE', async () => {
    const task = await createDispatchedTask();
    await service.transition(task.id, AI_TASK_STATUS.DISPATCHED, AI_TASK_STATUS.CALLBACK_RECEIVED);
    // 第二次同一合法对迁移：任务已在 callback_received，from=dispatched 过期 → updateMany count=0
    await expect(
      service.transition(task.id, AI_TASK_STATUS.DISPATCHED, AI_TASK_STATUS.CALLBACK_RECEIVED),
    ).rejects.toMatchObject({ code: 'AI_TASK_INVALID_STATE' });
  });

  it('无 reason 迁移不清空 errorMessage：failed(带 reason) → degraded(无 reason)', async () => {
    const task = await createDispatchedTask();
    const failed = await service.transition(
      task.id,
      AI_TASK_STATUS.DISPATCHED,
      AI_TASK_STATUS.FAILED,
      '执行失败：测试注入',
    );
    expect(failed.errorMessage).toBe('执行失败：测试注入');
    const degraded = await service.transition(
      task.id,
      AI_TASK_STATUS.FAILED,
      AI_TASK_STATUS.DEGRADED,
    );
    expect(degraded.errorMessage).toBe('执行失败：测试注入');
    expect(degraded.finishedAt).toBeTruthy();
  });

  it('非法迁移被拒：done → dispatched（submitTask 同步闭环后已到 done 终态）', async () => {
    const task = await service.submitTask('hello', {});
    expect(task.status).toBe(AI_TASK_STATUS.DONE);
    await expect(
      service.transition(task.id, AI_TASK_STATUS.DONE, AI_TASK_STATUS.DISPATCHED),
    ).rejects.toMatchObject({ code: 'AI_TASK_INVALID_STATE' });
  });
});
