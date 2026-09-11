import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { AiDispatchService } from './ai-dispatch.service';
import { AiTaskRepository } from './ai-task.repository';
import { AI_TASK_STATUS } from './ai-dispatch.states';
import { OPENCLAW_GATEWAY, type OpenClawGateway } from './gateway.interface';

export interface AiHealthSnapshot {
  healthy: boolean;
  lastCheckedAt: string | null;
  lastHealthyAt: string | null;
  lastError: string | null;
}

/** 健康轮询 + 超时扫描（规格 §8）。cron 是薄壳，核心方法公开供测试直接驱动。 */
@Injectable()
export class AiHealthService {
  private readonly logger = new Logger(AiHealthService.name);
  private snapshotState: AiHealthSnapshot = {
    healthy: false,
    lastCheckedAt: null,
    lastHealthyAt: null,
    lastError: '尚未检查',
  };

  constructor(
    @Inject(OPENCLAW_GATEWAY) private readonly gateway: OpenClawGateway,
    private readonly repo: AiTaskRepository,
    private readonly dispatch: AiDispatchService,
    private readonly audit: AuditService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async cronTick(): Promise<void> {
    await this.checkNow();
    await this.scanOverdue(new Date());
  }

  /** 健康探测一轮（失败只标记，不抛错——AI 故障永不阻塞） */
  async checkNow(): Promise<AiHealthSnapshot> {
    const now = new Date().toISOString();
    try {
      const ok = await this.gateway.health();
      this.snapshotState = {
        healthy: ok,
        lastCheckedAt: now,
        lastHealthyAt: ok ? now : this.snapshotState.lastHealthyAt,
        lastError: ok ? null : '健康探测失败',
      };
    } catch (err) {
      this.snapshotState = {
        healthy: false,
        lastCheckedAt: now,
        lastHealthyAt: this.snapshotState.lastHealthyAt,
        lastError: err instanceof Error ? err.message : String(err),
      };
    }
    return this.snapshotState;
  }

  snapshot(): AiHealthSnapshot {
    return this.snapshotState;
  }

  /** 超时扫描：dispatched 过 deadline → degraded('timeout')（D-P2-1）；
   * 与回调并发时条件迁移 count=0，捕获后跳过（回调已生效）。 */
  async scanOverdue(now: Date): Promise<number> {
    const overdue = await this.repo.findDispatchedOverdue(now);
    let degraded = 0;
    for (const task of overdue) {
      try {
        await this.dispatch.transition(
          task.id,
          AI_TASK_STATUS.DISPATCHED,
          AI_TASK_STATUS.DEGRADED,
          'timeout：超过截止时间未收到回调，请人工处理',
        );
        await this.audit.record({
          action: 'ai.task.timeout',
          objectType: 'ai_task',
          objectId: task.id,
          after: { taskType: task.taskType },
        });
        degraded++;
      } catch (err) {
        if (err instanceof AppException && err.code === ErrorCode.AI_TASK_INVALID_STATE) continue;
        throw err;
      }
    }
    if (degraded > 0) this.logger.warn(`超时扫描：${degraded} 个 AI 任务降级`);
    return degraded;
  }
}
