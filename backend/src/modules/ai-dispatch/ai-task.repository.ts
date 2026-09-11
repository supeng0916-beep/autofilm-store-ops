import { Injectable } from '@nestjs/common';
import type { AiTask, AiTaskEvent, AiTaskFeedback, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AI_TASK_TERMINAL, type AiTaskStatus } from './ai-dispatch.states';

/** AI 任务数据访问（S08）。状态迁移走条件 updateMany（与审批同款防竞态）；
 * 事件表只暴露 append + 查询，无 update/delete（D-P2-2）。 */
@Injectable()
export class AiTaskRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: {
    taskType: string;
    refType?: string | null;
    refId?: string | null;
    inputSummary: string;
    /** 技能提示词版本（批次5）：注册表登记，回滚后随映射更新 */
    skillVersion?: number;
    /** 直连计量行（2026-08-28 embedding）：不走派发状态机，直接终态 done + 用量字段 */
    status?: string;
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    costEstimateFen?: number;
  }): Promise<AiTask> {
    return this.prisma.aiTask.create({ data });
  }

  findById(id: string): Promise<AiTask | null> {
    return this.prisma.aiTask.findUnique({ where: { id } });
  }

  /** 条件状态迁移：仅当当前状态为 from 时更新；count=0 → 服务层抛 AI_TASK_INVALID_STATE */
  async transition(
    id: string,
    from: AiTaskStatus,
    data: {
      status: AiTaskStatus;
      errorMessage?: string | null;
      deadlineAt?: Date | null;
      dispatchedAt?: Date | null;
      callbackAt?: Date | null;
      finishedAt?: Date | null;
    },
  ): Promise<number> {
    const result = await this.prisma.aiTask.updateMany({ where: { id, status: from }, data });
    return result.count;
  }

  /** 输出落库（规格 §5.1 每任务必记录输出）：校验通过后的 output 以「草稿/建议」态持久化，
   * P2 无消费方（D-P2-2），结构保证无对外副作用 */
  saveOutput(id: string, output: Prisma.InputJsonValue): Promise<AiTask> {
    return this.prisma.aiTask.update({ where: { id }, data: { output } });
  }

  /** 数据字段更新（token/成本/模型；非状态字段，Task 8 使用）。
   * tokens 可选（P2 终审 triage）：无 usage 的回调仍可独立写 model/cost。 */
  updateUsage(
    id: string,
    data: { tokensIn?: number; tokensOut?: number; model?: string; costEstimateFen?: number },
  ): Promise<AiTask> {
    return this.prisma.aiTask.update({ where: { id }, data });
  }

  /** 超时扫描源：dispatched 且已过 deadline */
  findDispatchedOverdue(now: Date): Promise<AiTask[]> {
    return this.prisma.aiTask.findMany({
      where: { status: 'dispatched', deadlineAt: { lt: now } },
      take: 200,
    });
  }

  appendEvent(
    taskId: string,
    fromStatus: string | null,
    toStatus: string,
    reason?: string,
  ): Promise<AiTaskEvent> {
    return this.prisma.aiTaskEvent.create({ data: { taskId, fromStatus, toStatus, reason } });
  }

  findEvents(taskId: string): Promise<AiTaskEvent[]> {
    return this.prisma.aiTaskEvent.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });
  }

  /** 控制台列表源（V2.2b Task1）：status/taskType 可选筛选，最近 50 条（createdAt desc） */
  findConsoleTasks(filter: { status?: AiTaskStatus; taskType?: string }): Promise<AiTask[]> {
    return this.prisma.aiTask.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.taskType ? { taskType: filter.taskType } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /** 日预算口径（D-P2-6）：since 之后创建的任务成本合计（分） */
  async sumCostSince(since: Date): Promise<number> {
    const agg = await this.prisma.aiTask.aggregate({
      _sum: { costEstimateFen: true },
      where: { createdAt: { gte: since } },
    });
    return agg._sum.costEstimateFen ?? 0;
  }

  /** 成本日报源（Task 8）：since 之后创建的任务（含 0 成本与降级任务，计数完整） */
  findSince(since: Date): Promise<AiTask[]> {
    return this.prisma.aiTask.findMany({ where: { createdAt: { gte: since } }, take: 1000 });
  }

  /** 幂等查询（P3-05）：某 ref 的指定 taskType 是否存在非终态任务（在途/未闭环）。
   * 分配触发幂等键依据：已有非终态任务则跳过，重复分配事件不产生重复任务。 */
  findNonTerminalByRef(refType: string, refId: string, taskType: string): Promise<AiTask | null> {
    return this.prisma.aiTask.findFirst({
      where: { refType, refId, taskType, status: { notIn: [...AI_TASK_TERMINAL] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 最新已闭环输出（P3-05）：摘要展示端点取该 ref 最新的 done 任务。 */
  findLatestDoneByRef(refType: string, refId: string, taskType: string): Promise<AiTask | null> {
    return this.prisma.aiTask.findFirst({
      where: { refType, refId, taskType, status: 'done' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 最新任务（任意状态；2026-08-26 O8 评测缺口）：读端点派生「生成中/失败/完成」进度视图用。
   * 与 findLatestDoneByRef 配合：进度看最新一条，内容兜底取最新 done（最新失败时仍可展示旧摘要）。 */
  findLatestByRef(refType: string, refId: string, taskType: string): Promise<AiTask | null> {
    return this.prisma.aiTask.findFirst({
      where: { refType, refId, taskType },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 全部已闭环输出（P3-06）：草稿历史列表取该 ref 的所有 done 任务（倒序）。 */
  findDoneByRef(refType: string, refId: string, taskType: string): Promise<AiTask[]> {
    return this.prisma.aiTask.findMany({
      where: { refType, refId, taskType, status: 'done' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** SystemMeta 读取（v1.5 梯度限额）：键不存在返回 null */
  metaGet(key: string): Promise<string | null> {
    return this.prisma.systemMeta.findUnique({ where: { key } }).then((m) => m?.value ?? null);
  }

  /** SystemMeta 写入（v1.5 梯度限额）：upsert 幂等，临时提额键使用 */
  async metaSet(key: string, value: string): Promise<void> {
    await this.prisma.systemMeta.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  /** SystemMeta 原子认领（v1.5 修复轮 1）：create 撞主键唯一约束（P2002）即视为已被认领 → false。
   * 取代 read-then-write（metaGet→metaSet）两步非原子序列：并发双回调同时跨档时，
   * 仅一方认领成功，从机制上消除同档重复通知。判定不依赖错误类，同 lead.repository 先例。 */
  async metaTryClaim(key: string, value = '1'): Promise<boolean> {
    try {
      await this.prisma.systemMeta.create({ data: { key, value } });
      return true;
    } catch (err) {
      if (isUniqueConflict(err)) return false;
      throw err;
    }
  }

  /** 用户角色码（v1.5 临时提额 boss 硬校验；同构先例 delivery/analytics repository） */
  async userRoleCodes(userId: string): Promise<string[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { userRoles: { select: { role: { select: { code: true } } } } },
    });
    return user?.userRoles.map((ur) => ur.role.code) ?? [];
  }

  /** 写入人工反馈（P3-05，M11 学习链数据源）：采用/修改/拒绝。 */
  createFeedback(data: {
    taskId: string;
    decision: string;
    note?: string | null;
    userId: string;
  }): Promise<AiTaskFeedback> {
    return this.prisma.aiTaskFeedback.create({ data });
  }
}

/** Prisma 唯一约束冲突识别（P2002），不依赖 @prisma/client 具体错误类（lead.repository 同款） */
function isUniqueConflict(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}
