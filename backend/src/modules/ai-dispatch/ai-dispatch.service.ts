import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiTask } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { AiCallbackService } from './ai-callback.service';
import { AiTaskRegistry } from './ai-dispatch.registry';
import {
  AI_TASK_STATUS,
  AI_TASK_TERMINAL,
  canTransition,
  type AiTaskStatus,
} from './ai-dispatch.states';
import { AiCostService } from './ai-cost.service';
import { AiSwitchService } from './ai-switch.service';
import { AiTaskRepository } from './ai-task.repository';
import {
  OPENCLAW_GATEWAY,
  OpenClawTimeoutError,
  type GatewayRunResult,
  type OpenClawGateway,
} from './gateway.interface';
import { buildInputSummary } from './input-summary.util';
import { McpCallGovernorService } from './mcp-governor/mcp-call-governor.service';
import { maskDeep, scanForLeaks } from './masker';
import type { JwtPayload } from '../auth/auth.types';
import { NotificationService } from '../notification/notification.service';

/** 控制台可重试态（V2.2b Task2）：仅 failed/degraded 可重放（done 成功、cancelled 人为取消均无重放意义） */
const RETRYABLE_STATUSES: readonly AiTaskStatus[] = [
  AI_TASK_STATUS.FAILED,
  AI_TASK_STATUS.DEGRADED,
];

/** 人工接管事件标记（V2.2b Task2）：reason 固定字面量，幂等判定依据 */
const TAKEOVER_REASON = 'manual_takeover';

/** 降级/失败通知收件角色（V2.2b Task3）：boss（经营视野）+ sys_admin（集成监控），矩阵 AI 通道行口径 */
const AI_NOTIFY_ROLES = ['boss', 'sys_admin'];

/** lint 拦截失败标记（M02 T1）：ai-callback postLint hard 违规落 FAILED 的 reason 固定前缀 */
const LINT_BLOCKED_MARK = 'lint 拦截';

/** lint 拦截判定（M02 T1）：failed 且失败原因带 lint 拦截标记（postLint hard 违规）。
 * 类型谓词收窄 errorMessage 为非空——标记命中即说明 reason 已落库。 */
const isLintBlocked = (task: AiTask): task is AiTask & { errorMessage: string } =>
  task.status === AI_TASK_STATUS.FAILED && (task.errorMessage ?? '').includes(LINT_BLOCKED_MARK);

/** 重试反馈注入（M02 T1）：盲重放时模型不知道上轮为何被拦，会重复同样违规
 * （实况：短视频选题连续 4 次被极限词拦截）——把失败原因原样带给模型，知因再答。
 * 文案保持简洁：inputSummary 经 buildInputSummary 字段级截断（≤2000 且超长仍合法 JSON）。 */
const withLintFeedback = (
  payload: Record<string, unknown>,
  reason: string,
): Record<string, unknown> => ({
  ...payload,
  lintFeedback: `上轮输出被安全验证器拦截：${reason}。请修正该问题后重新输出完整结果。`,
});

/** ai-dispatch 统一入口（规格 §5.2）：外部模块只经 submitTask 触达 AI 通道。
 * 门禁注入点（D-P2-5）：Task 7 在此加开关检查，Task 8 在此加预算检查。
 * P3-00：submitTask 改为同步闭环——gateway.submit 一次调用完成 run 并取结果，经 applyEnvelope 落终态。 */
@Injectable()
export class AiDispatchService {
  private readonly logger = new Logger(AiDispatchService.name);

  /** 静默降级任务集（2026-08-28 UI 测试 #10）：submitTaskAutoRetry 的首次尝试即便降级
   * 也会立刻重试——此时群发 ai_task_degraded 告警纯属噪音（重试成功后任务照常 done，
   * 但通知已发出）。首次尝试的任务 ID 登记于此，transition 落 degraded/failed 时跳过通知
   * 并出队；重试任务不登记，两次都失败仍如实告警。单进程内存集合即可（部署形态单实例）。 */
  private readonly quietLandingNotify = new Set<string>();

  constructor(
    private readonly repo: AiTaskRepository,
    private readonly registry: AiTaskRegistry,
    private readonly switches: AiSwitchService,
    private readonly costs: AiCostService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    @Inject(OPENCLAW_GATEWAY) private readonly gateway: OpenClawGateway,
    @Inject(forwardRef(() => AiCallbackService)) private readonly callbacks: AiCallbackService,
    private readonly mcpGovernor: McpCallGovernorService,
  ) {}

  /** 提交 AI 任务并同步等结果：返回终态任务（done/failed/degraded）；提交失败不抛 5xx（设计决策 4）。
   * opts.onAssistantText（2026-08-26 流式输出）：网关 assistant 流事件回调（累计原文），
   * 仅透传不做脱敏判断——回调内容是模型输出而非出库上下文，终稿仍走 applyEnvelope 校验。 */
  /** 自动重试包装（2026-08-27 全流程测试 #4）：同步闭环 degraded/failed 自动重派一次——
   * 模型偶发输出漂移重放即好（实测降级重试成功率高）；两次都失败如实返回第二次结果
   * （degraded 可观测、可人工重试）。触发点（摘要/分级/草稿/助手）统一走此入口。 */
  async submitTaskAutoRetry(
    taskType: string,
    context: Record<string, unknown>,
    ref?: { type: string; id: string },
    opts?: { onAssistantText?: (cumulativeText: string) => void },
  ): Promise<AiTask> {
    const first = await this.submitTask(taskType, context, ref, {
      ...opts,
      quietLandingNotify: true,
    });
    if (first.status !== 'degraded' && first.status !== 'failed') return first;
    // lint 拦截反馈注入（M02 T1）：失败原因含 lint 拦截标记 → 重试载荷携带失败原因
    // （模型知因再答）；非 lint 失败与 degraded 保持盲重放（重放即好的既有语义）
    const retryContext = isLintBlocked(first)
      ? withLintFeedback(context, first.errorMessage)
      : context;
    const retried = await this.submitTask(taskType, retryContext, ref, opts);
    await this.repo.appendEvent(
      retried.id,
      null,
      AI_TASK_STATUS.PENDING,
      `auto_retry_after_${first.status}`,
    );
    return retried;
  }

  async submitTask(
    taskType: string,
    context: Record<string, unknown>,
    ref?: { type: string; id: string },
    opts?: {
      onAssistantText?: (cumulativeText: string) => void;
      /** 静默降级/失败通知（自动重试首次尝试用，见 quietLandingNotify 注释） */
      quietLandingNotify?: boolean;
    },
  ): Promise<AiTask> {
    const def = this.registry.get(taskType);
    // Task 7 门禁（D-P2-5）：开关关闭/通道未配置 → 主动抛 AI_DISABLED（503），
    // 区别于提交失败的静默降级——开关是管理员明示状态，调用方需要明确信号
    await this.switches.assertEnabled(taskType);
    // Task 8 门禁（D-P2-6）：当日成本已达熔断线 → 拒收新任务（AI_BUDGET_EXCEEDED 429），
    // 仅挡 AI 提交，业务 CRUD/审批不经过此路径
    await this.costs.assertWithinBudget();
    // 脱敏在通道边界强制执行（A04）：出库上下文与输入摘要均只保留脱敏后形态
    const maskedContext = maskDeep(context) as Record<string, unknown>;
    const task = await this.repo.create({
      taskType,
      refType: ref?.type ?? null,
      refId: ref?.id ?? null,
      // F03 源头修复：字段级截断保持合法 JSON（旧 slice(0,2000) 硬截断连累回声豁免与 retry 重放）
      inputSummary: buildInputSummary(maskedContext),
      ...(def.skillVersion !== undefined ? { skillVersion: def.skillVersion } : {}),
    });
    await this.repo.appendEvent(task.id, null, AI_TASK_STATUS.PENDING, 'created');
    if (opts?.quietLandingNotify) this.quietLandingNotify.add(task.id);

    const deadlineSeconds =
      def.deadlineSeconds ?? this.config.get<number>('WG_AI_DISPATCH_DEADLINE_S', 300);
    const deadline = new Date(Date.now() + deadlineSeconds * 1000);
    const leaks = scanForLeaks(maskedContext);
    if (leaks.length > 0) {
      // 宁拒发不泄漏（A04）：脱敏器漏网即阻断并留痕
      await this.audit.record({
        actorId: ref?.id,
        action: 'ai.dispatch.leak_blocked',
        objectType: 'ai_task',
        objectId: task.id,
        after: { leakPaths: leaks.map((l) => l.path) }, // 只记路径不记值（S04）
      });
      return this.transition(
        task.id,
        AI_TASK_STATUS.PENDING,
        AI_TASK_STATUS.DEGRADED,
        '脱敏校验未通过，任务未下发',
      );
    }
    // 迁移前置（P2 终审 triage）：先落 dispatched 再调 gateway.submit，
    // 结果到达时 dispatched 态必已存在，无需 grace，根治「结果快于迁移」竞态。
    // deadlineAt/dispatchedAt 随第一次迁移写入（与提交是否成功无关，提交失败则 dispatched→degraded）。
    const dispatched = await this.transition(
      task.id,
      AI_TASK_STATUS.PENDING,
      AI_TASK_STATUS.DISPATCHED,
      undefined,
      { deadlineAt: deadline, dispatchedAt: new Date() },
    );
    let result: GatewayRunResult;
    // F07/F11（2026-09-08）：登记在途 run——任务执行期内门店 MCP 端点的 tools/call
    // 据此归属任务、按 ≤3 次硬限并逐条审计（无状态端点自身无法识别调用方任务）
    this.mcpGovernor.beginRun(task.id);
    try {
      result = await this.gateway.submit(
        {
          taskId: task.id,
          taskType,
          context: maskedContext,
          constraints: def.constraints ?? {},
          callbackUrl: this.callbackUrlFor(task.id),
          deadline: deadline.toISOString(),
        },
        opts?.onAssistantText,
      );
    } catch (err) {
      // 超时与提交失败区分（D-P3-1 设计决策 3）：超时降级 reason='timeout' 并补发审计，
      // 运维据此区分「模型慢超时」与「网关断连」；连接/提交失败仍用「提交失败」。
      const isTimeout = err instanceof OpenClawTimeoutError;
      const reason = isTimeout
        ? 'timeout：AI 任务等待超时'
        : `提交失败：${err instanceof Error ? err.message : String(err)}`;
      this.logger.warn(`AI 任务 ${task.id}(${taskType}) 降级：${reason}`);
      if (isTimeout) {
        await this.audit.record({
          action: 'ai.task.timeout',
          objectType: 'ai_task',
          objectId: task.id,
          after: { taskType },
        });
      }
      return this.transition(task.id, AI_TASK_STATUS.DISPATCHED, AI_TASK_STATUS.DEGRADED, reason);
    } finally {
      // run 结束（成功/超时/提交失败同口径）：MCP 调用不再归属本任务、不再计入限次
      this.mcpGovernor.endRun(task.id);
    }
    // 同步闭环（P3-00）：结果经 applyEnvelope 走 dispatched→callback_received→validated→done
    // （或 failed）；两路（WS/HTTP）共用同一 Zod 校验/成本记账/终态幂等逻辑
    try {
      const { task: finalTask } = await this.callbacks.applyEnvelope(
        task.id,
        { taskType, ...result },
        'gateway',
      );
      return finalTask;
    } catch (err) {
      // 输出校验失败：applyEnvelope 已先落 degraded 再抛 VALIDATION_FAILED，读回 degraded 任务返回
      if (err instanceof AppException && err.code === ErrorCode.VALIDATION_FAILED) {
        return (await this.repo.findById(task.id)) ?? dispatched;
      }
      throw err;
    }
  }

  /** 重试（V2.2b Task2）：以新任务重放原任务（不修改原任务，refType/refId 继承）。
   * 限制（计划显式口径）：原输入只存脱敏 inputSummary，无法复原原始 payload——
   * retry 以 JSON.parse(inputSummary) 作 payload 重放（摘要即脱敏后输入，语义等价重放）；
   * 解析失败或非对象则退化为 {retriedFrom, inputSummary}，保住可追溯性。
   * 仅 failed/degraded 可重试，其余状态 409 AI_TASK_INVALID_STATE。 */
  async retry(id: string): Promise<AiTask> {
    const task = await this.repo.findById(id);
    if (!task) {
      throw new AppException(ErrorCode.NOT_FOUND, 'AI 任务不存在');
    }
    if (!RETRYABLE_STATUSES.includes(task.status as AiTaskStatus)) {
      throw new AppException(
        ErrorCode.AI_TASK_INVALID_STATE,
        `仅 failed/degraded 可重试，当前状态 ${task.status}`,
      );
    }
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(task.inputSummary);
      payload =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)
          : { retriedFrom: task.id, inputSummary: task.inputSummary };
    } catch {
      payload = { retriedFrom: task.id, inputSummary: task.inputSummary };
    }
    // lint 拦截同口径（M02 T1）：手动重试 lint 失败任务同样注入反馈，与自动重试一致——
    // 两路重试模型拿到的信息口径相同，不因入口不同而一个知因一个盲重放
    if (isLintBlocked(task)) payload = withLintFeedback(payload, task.errorMessage);
    return this.submitTask(
      task.taskType,
      payload,
      task.refType && task.refId ? { type: task.refType, id: task.refId } : undefined,
    );
  }

  /** 人工接管（V2.2b Task2）：业务含义=人工接手处理该任务的后续——只写事件与审计标记，
   * 不迁移状态机（事件 toStatus 保持当前态）；同一状态下的接管标记已存在则幂等跳过（不重复写）。 */
  async takeover(actor: JwtPayload, id: string): Promise<{ id: string; tookOver: true }> {
    const task = await this.repo.findById(id);
    if (!task) {
      throw new AppException(ErrorCode.NOT_FOUND, 'AI 任务不存在');
    }
    const events = await this.repo.findEvents(id);
    const already = events.some((e) => e.reason === TAKEOVER_REASON && e.toStatus === task.status);
    if (!already) {
      await this.repo.appendEvent(id, task.status, task.status, TAKEOVER_REASON);
      await this.audit.record({
        actorId: actor.sub,
        actorName: actor.username,
        action: 'ai.task.takeover',
        objectType: 'ai_task',
        objectId: id,
        after: { taskType: task.taskType, status: task.status },
      });
    }
    return { id, tookOver: true };
  }

  /** 条件迁移唯一入口：流转表校验 + 条件 update + 事件追加 */
  async transition(
    id: string,
    from: AiTaskStatus,
    to: AiTaskStatus,
    reason?: string,
    extra?: { deadlineAt?: Date; dispatchedAt?: Date; callbackAt?: Date; finishedAt?: Date },
  ): Promise<AiTask> {
    if (!canTransition(from, to)) {
      throw new AppException(ErrorCode.AI_TASK_INVALID_STATE, `非法状态迁移：${from} → ${to}`);
    }
    // 只更新本次提供的字段：时间戳是累积事实，不得在后续迁移中被 null 清掉
    // （如 callback_received 迁移不能清空 dispatched 时写入的 deadlineAt/dispatchedAt）；
    // errorMessage 同理——无 reason 的迁移（如 failed → degraded）不得静默抹掉已有失败信息
    const data: Parameters<AiTaskRepository['transition']>[2] = { status: to };
    if (reason !== undefined) data.errorMessage = reason;
    if (extra?.deadlineAt) data.deadlineAt = extra.deadlineAt;
    if (extra?.dispatchedAt) data.dispatchedAt = extra.dispatchedAt;
    if (extra?.callbackAt) data.callbackAt = extra.callbackAt;
    if (AI_TASK_TERMINAL.includes(to)) data.finishedAt = extra?.finishedAt ?? new Date();
    const count = await this.repo.transition(id, from, data);
    if (count === 0) {
      throw new AppException(ErrorCode.AI_TASK_INVALID_STATE, `AI 任务已离开 ${from} 态`);
    }
    await this.repo.appendEvent(id, from, to, reason);
    const updated = await this.repo.findById(id);
    if (!updated) {
      throw new AppException(ErrorCode.INTERNAL, 'AI 任务状态读取失败');
    }
    // 降级/失败落定通知（V2.2b Task3）：transition 是全部状态落定的唯一入口——
    // 提交失败/超时（submitTask）、输出校验失败与上报失败（applyEnvelope）、超时扫描
    // （scanOverdue）均经此迁移，一处接线即覆盖全部降级/失败路径。
    // quietLandingNotify（2026-08-28 UI 测试 #10）：自动重试的首次尝试静默——落定即出队；
    // done 等其他终态同样出队，防止集合无界增长
    const quiet = this.quietLandingNotify.has(id);
    if (quiet || AI_TASK_TERMINAL.includes(to)) this.quietLandingNotify.delete(id);
    if ((to === AI_TASK_STATUS.DEGRADED || to === AI_TASK_STATUS.FAILED) && !quiet) {
      this.notifyLanding(updated, to, reason);
    }
    return updated;
  }

  /** 降级/失败落定通知（V2.2b Task3）：群发 boss+sys_admin，尽力而为（void 不 await + 内部兜底，
   * 与 V2.2a 审批/排期接线同构）；kind 区分降级/失败，title 携带 taskType，link 指向控制台 */
  private notifyLanding(task: AiTask, to: AiTaskStatus, reason?: string): void {
    const degraded = to === AI_TASK_STATUS.DEGRADED;
    const kind = degraded ? 'ai_task_degraded' : 'ai_task_failed';
    void this.safeNotify(
      () =>
        this.notifications.notifyRoleHolders(AI_NOTIFY_ROLES, {
          kind,
          title: `AI 任务${degraded ? '降级' : '失败'}：${task.taskType}`,
          body: reason,
          link: '/ai-tasks',
          sourceType: 'ai_task',
          sourceId: task.id,
        }),
      `${kind}(${task.id})`,
    );
  }

  /** 尽力而为发通知（S09）：内部兜底捕获，任何失败仅记日志不外抛；调用处一律 void 不 await */
  private async safeNotify(action: () => Promise<unknown>, context: string): Promise<void> {
    try {
      await action();
    } catch (err) {
      this.logger.warn(
        `通知发送失败（${context}）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 回调地址：NestJS 对外基址 + 任务专属路径（规格 §5.2；P3-00 起真实链路走 WS，此值仅 echo/测试用） */
  private callbackUrlFor(taskId: string): string {
    const port = this.config.get<number>('WG_PORT', 8000);
    return `http://localhost:${port}/api/v1/internal/ai-callback/${taskId}`;
  }
}
