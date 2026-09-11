import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import type { AiTask, Prisma } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { CallbackEnvelope } from './ai-dispatch.protocol';
import { AiCostService } from './ai-cost.service';
import { AiTaskRegistry } from './ai-dispatch.registry';
import { AiDispatchService } from './ai-dispatch.service';
import { AI_TASK_STATUS, AI_TASK_TERMINAL, type AiTaskStatus } from './ai-dispatch.states';
import { AiTaskRepository } from './ai-task.repository';

export interface ApplyEnvelopeResult {
  task: AiTask;
  /** 终态幂等命中：结果对任务无任何效果（D-P2-8） */
  ignored: boolean;
}

/** 结果受理（P2-04 / P3-00）：HTTP 回调（controller 验签后）与 Gateway 同步闭环（submitTask）
 * 共用同一入口 applyEnvelope。source 标记结果来源，两路都只认信封 schema，
 * 终态幂等（D-P2-8）与 taskType 交叉校验（Task 0）在此统一生效。 */
@Injectable()
export class AiCallbackService {
  private readonly logger = new Logger(AiCallbackService.name);

  constructor(
    private readonly repo: AiTaskRepository,
    private readonly registry: AiTaskRegistry,
    @Inject(forwardRef(() => AiDispatchService)) private readonly dispatch: AiDispatchService,
    private readonly audit: AuditService,
    private readonly costs: AiCostService,
  ) {}

  async applyEnvelope(
    taskId: string,
    envelope: CallbackEnvelope,
    source: 'http' | 'gateway',
  ): Promise<ApplyEnvelopeResult> {
    const task = await this.repo.findById(taskId);
    if (!task) {
      throw new AppException(ErrorCode.NOT_FOUND, 'AI 任务不存在');
    }
    // 信封 taskType 交叉校验（P2 终审 triage）：与任务记录不符 = 内容不可信，
    // 沿用验签失败语义（401 AI_SIGNATURE_INVALID）拒收并审计，不进入状态机
    if (envelope.taskType !== task.taskType) {
      await this.audit.record({
        action: 'ai.callback.rejected',
        objectType: 'ai_task',
        objectId: taskId,
        after: {
          reason: 'taskType_mismatch',
          taskType: task.taskType,
          envelopeTaskType: envelope.taskType,
          source,
        },
      });
      throw new AppException(ErrorCode.AI_SIGNATURE_INVALID, '回调信封 taskType 与任务记录不符');
    }
    // 幂等：终态任务的重复/超期结果不再产生任何效果（D-P2-8）
    if ((AI_TASK_TERMINAL as readonly string[]).includes(task.status)) {
      return { task, ignored: true };
    }

    if (envelope.status === 'failed') {
      const failed = await this.dispatch.transition(
        taskId,
        task.status as AiTaskStatus,
        AI_TASK_STATUS.FAILED,
        envelope.errorMessage ?? 'OpenClaw 上报执行失败',
      );
      await this.audit.record({
        action: 'ai.task.failed',
        objectType: 'ai_task',
        objectId: taskId,
        after: { taskType: task.taskType, source },
      });
      // Task 8：失败也耗 token——failed 路径若带 usage 同样计量落库（D-P2-6）
      await this.costs.recordUsage(
        taskId,
        envelope.usage,
        envelope.model,
        envelope.costEstimateFen,
      );
      return { task: failed, ignored: false };
    }

    // done 路径：先落 callback_received，再按注册表 schema 校验 output
    await this.dispatch.transition(
      taskId,
      task.status as AiTaskStatus,
      AI_TASK_STATUS.CALLBACK_RECEIVED,
      undefined,
      { callbackAt: new Date() },
    );
    const def = this.registry.get(task.taskType);
    // 归一化钩子（2026-08-21）：先确定性翻译模型输出漂移，再按注册表严格 schema 校验；
    // 未挂钩子的任务行为与原先完全一致
    const normalized = def.normalize ? def.normalize(envelope.output) : envelope.output;
    const parsed = def.outputSchema.safeParse(normalized);
    if (!parsed.success) {
      await this.dispatch.transition(
        taskId,
        AI_TASK_STATUS.CALLBACK_RECEIVED,
        AI_TASK_STATUS.DEGRADED,
        `输出校验失败：${parsed.error.issues
          .map((i) => i.message)
          .join('; ')
          .slice(0, 200)}`,
      );
      await this.audit.record({
        action: 'ai.callback.schema_rejected',
        objectType: 'ai_task',
        objectId: taskId,
        after: { taskType: task.taskType, source },
      });
      // F06（2026-09-08）：模型已产出（消耗 token），降级同样计量——旧实现丢 usage，
      // phase12 实测 2 条 schema 降级任务 tokens 为空，成本日报按 0 聚合失真。
      // 口径与 failed/lint 拦截路径一致：先计量后抛。
      await this.costs.recordUsage(
        taskId,
        envelope.usage,
        envelope.model,
        envelope.costEstimateFen,
      );
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'AI 输出不符合约定结构，已拒收并降级');
    }
    // 输出验证钩子（2026-09-04 M02 阶段一 Task2）：schema 只保证结构合法，lint 管行为红线——
    // hard（极限词/英文泄漏）→ failed（与网关上报失败同路径：errorMessage 记 lint:<rule>，
    //   submitTaskAutoRetry/retry 对 failed 均走既有重试）；
    // soft（markdown/超长）→ 放行留痕，输出原样落库。
    if (def.postLint) {
      // ctx.inputSummary：提交载荷脱敏摘要，供 lint 做「用户输入原词回声」豁免判断
      const lint = def.postLint(parsed.data, { inputSummary: task.inputSummary });
      const hard = lint.issues.filter((i) => i.severity === 'hard');
      if (hard.length > 0) {
        const reason = `lint 拦截：${hard.map((i) => `lint:${i.rule}：${i.message}`).join('；')}`;
        const failed = await this.dispatch.transition(
          taskId,
          AI_TASK_STATUS.CALLBACK_RECEIVED,
          AI_TASK_STATUS.FAILED,
          reason,
        );
        await this.audit.record({
          action: 'ai.callback.lint_rejected',
          objectType: 'ai_task',
          objectId: taskId,
          after: { taskType: task.taskType, rules: hard.map((i) => i.rule), source },
        });
        // 模型已产出（消耗 token），失败同样计量（与网关上报失败路径一致）
        await this.costs.recordUsage(
          taskId,
          envelope.usage,
          envelope.model,
          envelope.costEstimateFen,
        );
        return { task: failed, ignored: false };
      }
      for (const issue of lint.issues) {
        this.logger.warn(
          `AI 任务 ${taskId}(${task.taskType}) lint 软违规放行：rule=${issue.rule} field=${issue.field} ${issue.message}`,
        );
      }
    }
    await this.dispatch.transition(
      taskId,
      AI_TASK_STATUS.CALLBACK_RECEIVED,
      AI_TASK_STATUS.VALIDATED,
    );
    // 校验通过的 output 即刻落库（规格 §5.1）：「草稿/建议」态
    await this.repo.saveOutput(taskId, parsed.data as Prisma.InputJsonValue);
    // Task 8：usage/cost 落库与 token 上限告警（D-P2-6），在 VALIDATED → DONE 之前完成
    await this.costs.recordUsage(taskId, envelope.usage, envelope.model, envelope.costEstimateFen);
    const done = await this.dispatch.transition(
      taskId,
      AI_TASK_STATUS.VALIDATED,
      AI_TASK_STATUS.DONE,
    );
    await this.audit.record({
      action: 'ai.task.done',
      objectType: 'ai_task',
      objectId: taskId,
      after: { taskType: task.taskType, model: envelope.model ?? null, source },
    });
    return { task: done, ignored: false };
  }
}
