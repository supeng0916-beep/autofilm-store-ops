import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { NotificationService } from '../notification/notification.service';
import { AiTaskRepository } from './ai-task.repository';
import { estimateCostFen, parseModelPrices } from './ai-pricing';
import type { UsageSchema } from './ai-dispatch.protocol';
import type { z } from 'zod';

/** 成本统计与限额（规格 §5.6；机制不省，测试期数值为高额熔断线，D-P2-6）。
 * 拒收线 = 日预算熔断线；单任务 token 上限仅告警审计。
 * 测试期观察口径：token 精确记录 + dailySummary 日报，供 leader 定正式限额。
 * v1.5 注意事项 6：梯度通知（60%/80% 各每日一次）+ boss 临时提额（按日期 key，次日自动回落）。 */
@Injectable()
export class AiCostService {
  private readonly logger = new Logger(AiCostService.name);

  private static readonly WARN_RATIO = 0.6;
  private static readonly ALERT_RATIO = 0.8;

  constructor(
    private readonly repo: AiTaskRepository,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  /** 当日有效预算（v1.5 注意事项 6）：SystemMeta 临时提额（ai_budget_override:<date>）优先于 env 基准；
   * 提额键按日期命名，次日读取自然回落，无需清理任务。非法/缺失值回退 env 基准。 */
  async effectiveDailyBudgetFen(): Promise<number> {
    const base = this.config.get<number>('WG_AI_DAILY_BUDGET_FEN', 10000);
    const raw = await this.repo.metaGet(`ai_budget_override:${localDateKey(new Date())}`);
    const v = raw === null ? NaN : Number(raw);
    return Number.isFinite(v) && v > 0 ? v : base;
  }

  /** 日预算门禁：当日已耗 ≥ 有效预算 → 拒收新任务（业务 CRUD 不受影响） */
  async assertWithinBudget(): Promise<void> {
    const budgetFen = await this.effectiveDailyBudgetFen();
    const spent = await this.repo.sumCostSince(startOfToday());
    if (spent >= budgetFen) {
      throw new AppException(ErrorCode.AI_BUDGET_EXCEEDED, 'AI 日预算已用尽，新任务已暂停', {
        spentFen: spent,
        budgetFen,
      });
    }
  }

  /** 回调用量落库 + token 上限告警；末尾检查梯度通知（v1.5 注意事项 6）。
   * 2026-08-28 P5：网关不上报金额（未配置模型计价）→ 有 token 无 cost 时按单价表估算
   * （ai-pricing，分=token/1e6×单价），网关上报值优先；模型无单价则如实留空。 */
  async recordUsage(
    taskId: string,
    usage: z.infer<typeof UsageSchema> | undefined,
    model: string | undefined,
    costEstimateFen: number | undefined,
  ): Promise<void> {
    let costFen = costEstimateFen;
    if (costFen === undefined && usage && (usage.tokensIn > 0 || usage.tokensOut > 0)) {
      costFen =
        estimateCostFen(
          model,
          usage.tokensIn,
          usage.tokensOut,
          parseModelPrices(this.config.get<string>('WG_AI_MODEL_PRICES_FEN_PER_MTOK')),
        ) ?? undefined;
    }
    if (!usage) {
      // 无 usage 仍独立写 model/cost（P2 终审 triage）：failed 回调可能无 usage 但带模型/成本，
      // 现实现整段跳过会丢字段
      if (model !== undefined || costFen !== undefined) {
        await this.repo.updateUsage(taskId, { model, costEstimateFen: costFen });
      }
    } else {
      await this.repo.updateUsage(taskId, {
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        model,
        costEstimateFen: costFen,
      });
      const cap = this.config.get<number>('WG_AI_TASK_MAX_TOKENS', 20000);
      if (usage.tokensIn + usage.tokensOut > cap) {
        this.logger.warn(`AI 任务 ${taskId} 超出单任务 token 上限（${cap}）`);
        await this.audit.record({
          action: 'ai.task.token_cap_exceeded',
          objectType: 'ai_task',
          objectId: taskId,
          after: { tokens: usage.tokensIn + usage.tokensOut, cap },
        });
      }
    }
    // 梯度通知检查：尽力而为——失败只记日志，不得阻塞/破坏回调主流程
    // （NotificationService 本身自捕获；此处 catch 兜住预算/去重键读取段）
    await this.checkBudgetNotify().catch((e) =>
      this.logger.warn(
        `AI 预算梯度通知检查失败（任务 ${taskId}）：${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  /** 成本记账后检查梯度：跨 60%/80% 各通知 boss 一次（SystemMeta 去重键 ai_cost_notified:<level>:<date>，
   * 落库保证重启不重发）；尽力而为——NotificationService 自捕获，写入失败不影响主流程。 */
  async checkBudgetNotify(): Promise<void> {
    const budget = await this.effectiveDailyBudgetFen();
    if (budget <= 0) return;
    const spent = await this.repo.sumCostSince(startOfToday());
    const date = localDateKey(new Date());
    const tiers: Array<{ level: 'warn' | 'alert'; ratio: number; text: string }> = [
      {
        level: 'warn',
        ratio: AiCostService.WARN_RATIO,
        text: 'AI 当日费用已达预算 60%，请留意用量',
      },
      {
        level: 'alert',
        ratio: AiCostService.ALERT_RATIO,
        text: 'AI 当日费用已达预算 80%，接近硬上限',
      },
    ];
    for (const t of tiers) {
      if (spent < budget * t.ratio) continue;
      const key = `ai_cost_notified:${t.level}:${date}`;
      // 原子认领取代 read-then-write（v1.5 修复轮 1）：并发双回调同时跨档时仅一方成功，
      // 从机制上消除同档重复通知；create 撞 P2002 即已认领 → continue
      if (!(await this.repo.metaTryClaim(key))) continue;
      // await 而非 void：保证通知写入对调用方可观测（测试断言依赖）；
      // notifyRoleHolders 自捕获不抛，不会破坏主流程
      await this.notifications.notifyRoleHolders(['boss'], {
        kind: 'ai_budget_warn',
        title: t.text,
        body: `已用 ${(spent / 100).toFixed(2)} 元 / 预算 ${(budget / 100).toFixed(2)} 元`,
        link: '/ai-settings',
        sourceType: 'ai_budget',
        sourceId: date,
      });
    }
  }

  /** 控制台成本横幅数据（v1.5 注意事项 6）：当日已耗/有效预算/梯度线 */
  async budgetStatus(): Promise<{
    date: string;
    spentFen: number;
    budgetFen: number;
    warnFen: number;
    alertFen: number;
  }> {
    const budget = await this.effectiveDailyBudgetFen();
    const spent = await this.repo.sumCostSince(startOfToday());
    return {
      date: localDateKey(new Date()),
      spentFen: spent,
      budgetFen: budget,
      warnFen: Math.round(budget * AiCostService.WARN_RATIO),
      alertFen: Math.round(budget * AiCostService.ALERT_RATIO),
    };
  }

  /** 老板临时提额（v1.5 注意事项 6）：仅当日有效，次日自动回落 env 基准；审计留痕。
   * 角色硬校验在服务层：仅 boss（权限点近似口径不构成本层依据，team assertManager 先例）。 */
  async setDailyOverride(actorId: string, actorName: string, budgetFen: number): Promise<void> {
    const roles = await this.repo.userRoleCodes(actorId);
    if (!roles.includes('boss')) {
      throw new AppException(ErrorCode.PERM_DENIED, '仅老板可调整 AI 当日预算');
    }
    const date = localDateKey(new Date());
    const key = `ai_budget_override:${date}`;
    await this.repo.metaSet(key, String(budgetFen));
    await this.audit.record({
      actorId,
      actorName,
      action: 'ai.budget.override',
      objectType: 'system_meta',
      objectId: key,
      after: { budgetFen },
    });
  }

  /** 成本分解（v1.5 注意事项 6：看出钱花在什么地方）：近 N 天按 日期×模型×任务类型 聚合。
   * 排序口径：日期倒序，同日按 costFen 倒序。model 缺失归 'unknown'。 */
  async breakdown(days: number): Promise<
    {
      date: string;
      model: string;
      taskType: string;
      taskCount: number;
      tokensIn: number;
      tokensOut: number;
      costFen: number;
    }[]
  > {
    const since = new Date(startOfToday());
    since.setDate(since.getDate() - (days - 1));
    const tasks = await this.repo.findSince(since);
    const map = new Map<
      string,
      {
        date: string;
        model: string;
        taskType: string;
        taskCount: number;
        tokensIn: number;
        tokensOut: number;
        costFen: number;
      }
    >();
    for (const t of tasks) {
      const date = localDateKey(t.createdAt);
      const model = t.model ?? 'unknown';
      const key = [date, model, t.taskType].join('|');
      const row = map.get(key) ?? {
        date,
        model,
        taskType: t.taskType,
        taskCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        costFen: 0,
      };
      row.taskCount++;
      row.tokensIn += t.tokensIn ?? 0;
      row.tokensOut += t.tokensOut ?? 0;
      row.costFen += t.costEstimateFen ?? 0;
      map.set(key, row);
    }
    return [...map.values()].sort((a, b) => b.date.localeCompare(a.date) || b.costFen - a.costFen);
  }

  /** 成本日报：按本地日期聚合（tasks/tokens/cost） */
  async dailySummary(
    days: number,
  ): Promise<
    { date: string; taskCount: number; tokensIn: number; tokensOut: number; costFen: number }[]
  > {
    const since = new Date(startOfToday());
    since.setDate(since.getDate() - (days - 1));
    const tasks = await this.repo.findSince(since);
    const byDate = new Map<
      string,
      { taskCount: number; tokensIn: number; tokensOut: number; costFen: number }
    >();
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      byDate.set(localDateKey(d), { taskCount: 0, tokensIn: 0, tokensOut: 0, costFen: 0 });
    }
    for (const t of tasks) {
      const row = byDate.get(localDateKey(t.createdAt));
      if (!row) continue;
      row.taskCount++;
      row.tokensIn += t.tokensIn ?? 0;
      row.tokensOut += t.tokensOut ?? 0;
      row.costFen += t.costEstimateFen ?? 0;
    }
    return [...byDate.entries()].map(([date, row]) => ({ date, ...row }));
  }
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
