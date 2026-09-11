import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/** AI 使用画像聚合（V1.5 批次3）：人+AI 协作画像——谁在用、用哪个技能、花多少、采纳率。
 * 纯确定性查询（无新 AI）；数据源 ai_tasks（refType='agent' 时 refId=提交者 userId）+
 * ai_task_feedback（decision 自由串，前端语义 采用/修改/拒绝）。
 * 天窗默认 30 天；门禁 ai:cost:view 在控制器层（与成本端点同口径）。 */
@Injectable()
export class AiUsageService {
  constructor(private readonly prisma: PrismaService) {}

  /** 影子模式场景二·话术对比（2026-09-03，事件源实现——销售零新增操作）：
   * original=ai_tasks.output.message（AI 草稿原文）；actual=同 taskId 最新 draft_created 事件
   * 的人工改写终版（无改写=照发，相似度 1）；send_recorded 事件为触发器（有实发才算一次样本）。
   * 相似度=2-gram Dice（确定性无 AI），改动率=1-相似度。 */
  async draftShadow(days = 30): Promise<{
    days: number;
    total: number;
    avgSimilarity: number;
    verbatimRate: number;
    samples: Array<{
      taskId: string;
      leadId: string;
      similarity: number;
      original: string;
      actual: string;
    }>;
    /** 照发候选（阶段三 B2）：similarity≥0.999＝无改写照发的样本最近 ≤10 条，逐条可一键转经验卡 */
    verbatimCandidates: Array<{ taskId: string; leadId: string; original: string }>;
  }> {
    const since = new Date();
    since.setDate(since.getDate() - (days - 1));
    since.setHours(0, 0, 0, 0);
    const events = await this.prisma.leadEvent.findMany({
      where: { kind: { in: ['send_recorded', 'draft_created'] }, occurredAt: { gte: since } },
      orderBy: { occurredAt: 'asc' },
      select: { leadId: true, kind: true, content: true, occurredAt: true },
    });
    // 每 (leadId, taskId) 的最新改写与是否实发（事件按时间升序，首条 send_recorded 即样本时间）
    const latestEdit = new Map<string, string>();
    const sentAt = new Map<string, Date>();
    for (const e of events) {
      const c = e.content as { taskId?: string; text?: string } | null;
      if (!c?.taskId) continue;
      const key = `${e.leadId}:${c.taskId}`;
      if (e.kind === 'draft_created' && typeof c.text === 'string') latestEdit.set(key, c.text);
      if (e.kind === 'send_recorded' && !sentAt.has(key)) sentAt.set(key, e.occurredAt);
    }
    const taskIds = [...new Set([...sentAt.keys()].map((k) => k.split(':')[1]))];
    const tasks = taskIds.length
      ? await this.prisma.aiTask.findMany({
          where: { id: { in: taskIds }, taskType: 'sales.draft_message' },
          select: { id: true, refId: true, output: true },
        })
      : [];
    const byId = new Map(tasks.map((x) => [x.id, x]));
    const rows: Array<{
      taskId: string;
      leadId: string;
      similarity: number;
      original: string;
      actual: string;
      sentAt: Date;
    }> = [];
    for (const [key, at] of sentAt) {
      const [leadId, taskId] = key.split(':');
      const task = byId.get(taskId);
      if (!task) continue;
      const out = task.output as { message?: unknown } | null;
      const original = typeof out?.message === 'string' ? out.message : '';
      if (!original) continue;
      const actual = latestEdit.get(key) ?? original; // 无改写=照发
      rows.push({
        taskId,
        leadId,
        similarity: Number(bigramSimilarity(original, actual).toFixed(3)),
        original: original.slice(0, 80),
        actual: actual.slice(0, 80),
        sentAt: at,
      });
    }
    rows.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime()); // 旧→新，尾部即最近样本
    const verbatim = rows.filter((r) => r.similarity >= 0.999).length;
    return {
      days,
      total: rows.length,
      avgSimilarity: rows.length
        ? Number((rows.reduce((s, r) => s + r.similarity, 0) / rows.length).toFixed(3))
        : 1,
      verbatimRate: rows.length ? Number((verbatim / rows.length).toFixed(3)) : 1,
      // 最近 10 条样本（含 taskId 供一键转卡；80 截断仅展示用，全文转卡时服务端按 taskId 重查）
      samples: rows.slice(-10).map(({ taskId, leadId, similarity, original, actual }) => ({
        taskId,
        leadId,
        similarity,
        original,
        actual,
      })),
      // 照发候选：最近在前（面板顶部即最新照发），≤10 条
      verbatimCandidates: [...rows]
        .filter((r) => r.similarity >= 0.999)
        .slice(-10)
        .reverse()
        .map(({ taskId, leadId, original }) => ({ taskId, leadId, original })),
    };
  }

  /** 影子模式首场景（V1.5 批次5）：AI 判级 vs 人工终判——聚合 lead_events 的 intent_confirmed
   * 事件（P3-07 改判留痕 {aiLevel, humanLevel, overridden, reason?}）。
   * 一致率=未改判占比；改判分布=aiLevel→humanLevel 矩阵；理由样本供人读。
   * 这是「AI 和老板差多少」的第一份可量化证据（影子模式后续场景复用本方法的数据底座）。 */
  async intentShadow(days = 30): Promise<{
    days: number;
    total: number;
    agreed: number;
    agreementRate: number;
    overrides: Array<{ aiLevel: string; humanLevel: string; count: number }>;
    overrideSamples: Array<{
      leadId: string;
      leadNo: string;
      aiLevel: string;
      humanLevel: string;
      reason: string | null;
    }>;
  }> {
    const since = new Date();
    since.setDate(since.getDate() - (days - 1));
    since.setHours(0, 0, 0, 0);
    const events = await this.prisma.leadEvent.findMany({
      where: { kind: 'intent_confirmed', occurredAt: { gte: since } },
      select: { leadId: true, content: true, occurredAt: true },
      orderBy: { occurredAt: 'desc' },
    });
    const rows = events
      .map((e) => {
        const c = e.content as {
          aiLevel?: string;
          humanLevel?: string;
          overridden?: boolean;
          reason?: string;
        } | null;
        return c?.aiLevel && c?.humanLevel
          ? {
              leadId: e.leadId,
              aiLevel: c.aiLevel,
              humanLevel: c.humanLevel,
              overridden: c.overridden ?? c.aiLevel !== c.humanLevel,
              reason: c.reason ?? null,
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const agreed = rows.filter((r) => !r.overridden).length;
    const ovMap = new Map<string, { aiLevel: string; humanLevel: string; count: number }>();
    for (const r of rows) {
      if (!r.overridden) continue;
      const key = `${r.aiLevel}→${r.humanLevel}`;
      const row = ovMap.get(key) ?? { aiLevel: r.aiLevel, humanLevel: r.humanLevel, count: 0 };
      row.count += 1;
      ovMap.set(key, row);
    }
    // 样本行的 leadIds 批量补 leadNo（前端展示客资编号；一键转经验卡也随卡带上）
    const sampleRows = rows.filter((r) => r.overridden).slice(0, 10);
    const leads = sampleRows.length
      ? await this.prisma.lead.findMany({
          where: { id: { in: sampleRows.map((r) => r.leadId) } },
          select: { id: true, leadNo: true },
        })
      : [];
    const leadNoOf = new Map(leads.map((l) => [l.id, l.leadNo]));
    return {
      days,
      total: rows.length,
      agreed,
      agreementRate: rows.length ? agreed / rows.length : 0,
      overrides: [...ovMap.values()].sort((a, b) => b.count - a.count),
      overrideSamples: sampleRows.map((r) => ({
        leadId: r.leadId,
        leadNo: leadNoOf.get(r.leadId) ?? '(未知)',
        aiLevel: r.aiLevel,
        humanLevel: r.humanLevel,
        reason: r.reason,
      })),
    };
  }

  async summary(days = 30): Promise<{
    days: number;
    byUser: Array<{
      userId: string;
      username: string;
      displayName: string;
      taskCount: number;
      doneCount: number;
      failCount: number;
      costFen: number;
      feedbackTotal: number;
      feedbackAdopted: number;
    }>;
    byTaskType: Array<{ taskType: string; count: number; doneCount: number; costFen: number }>;
    byDay: Array<{ date: string; count: number; costFen: number }>;
    total: { taskCount: number; costFen: number };
  }> {
    const since = new Date();
    since.setDate(since.getDate() - (days - 1));
    since.setHours(0, 0, 0, 0);

    const [tasks, feedbacks] = await Promise.all([
      this.prisma.aiTask.findMany({
        where: { createdAt: { gte: since } },
        select: {
          taskType: true,
          refType: true,
          refId: true,
          status: true,
          costEstimateFen: true,
          createdAt: true,
        },
      }),
      this.prisma.aiTaskFeedback.findMany({
        where: { createdAt: { gte: since } },
        select: { taskId: true, decision: true, userId: true },
      }),
    ]);

    const userIds = [
      ...new Set(tasks.filter((t) => t.refType === 'agent' && t.refId).map((t) => t.refId!)),
    ];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, username: true, displayName: true },
        })
      : [];
    const userOf = new Map(users.map((u) => [u.id, u]));

    // 按人（提交者视角：agent 任务归 refId 本人；system 任务不归人）
    const byUserMap = new Map<
      string,
      {
        userId: string;
        username: string;
        displayName: string;
        taskCount: number;
        doneCount: number;
        failCount: number;
        costFen: number;
        feedbackTotal: number;
        feedbackAdopted: number;
      }
    >();
    for (let i = 0; i < tasks.length; i += 1) {
      const t = tasks[i];
      if (t.refType !== 'agent' || !t.refId) continue;
      const row = byUserMap.get(t.refId) ?? {
        userId: t.refId,
        username: userOf.get(t.refId)?.username ?? '(未知)',
        displayName: userOf.get(t.refId)?.displayName ?? '',
        taskCount: 0,
        doneCount: 0,
        failCount: 0,
        costFen: 0,
        feedbackTotal: 0,
        feedbackAdopted: 0,
      };
      row.taskCount += 1;
      if (t.status === 'done') row.doneCount += 1;
      if (t.status === 'failed' || t.status === 'degraded' || t.status === 'timeout') {
        row.failCount += 1;
      }
      row.costFen += t.costEstimateFen ?? 0;
      byUserMap.set(t.refId, row);
    }
    // 反馈归提交者（反馈人≈提交人；跨人反馈按反馈人算，M11 语义）
    for (const f of feedbacks) {
      const row = byUserMap.get(f.userId);
      if (!row) continue;
      row.feedbackTotal += 1;
      if (f.decision === 'adopted') row.feedbackAdopted += 1;
    }

    // 按技能
    const byTypeMap = new Map<
      string,
      { taskType: string; count: number; doneCount: number; costFen: number }
    >();
    for (const t of tasks) {
      const row = byTypeMap.get(t.taskType) ?? {
        taskType: t.taskType,
        count: 0,
        doneCount: 0,
        costFen: 0,
      };
      row.count += 1;
      if (t.status === 'done') row.doneCount += 1;
      row.costFen += t.costEstimateFen ?? 0;
      byTypeMap.set(t.taskType, row);
    }

    // 按日（本地日期键）
    const byDayMap = new Map<string, { date: string; count: number; costFen: number }>();
    const dateKeyOf = (d: Date): string => {
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };
    for (const t of tasks) {
      const key = dateKeyOf(t.createdAt);
      const row = byDayMap.get(key) ?? { date: key, count: 0, costFen: 0 };
      row.count += 1;
      row.costFen += t.costEstimateFen ?? 0;
      byDayMap.set(key, row);
    }

    const byUser = [...byUserMap.values()].sort((a, b) => b.taskCount - a.taskCount);
    const byTaskType = [...byTypeMap.values()].sort((a, b) => b.count - a.count);
    const byDay = [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    return {
      days,
      byUser,
      byTaskType,
      byDay,
      total: {
        taskCount: tasks.length,
        costFen: tasks.reduce((s, t) => s + (t.costEstimateFen ?? 0), 0),
      },
    };
  }
}

/** 2-gram Dice 相似度（确定性无 AI）：中文短文本稳定，无分词依赖。
 * 导出供 shadow-harvest 转卡时复算相似度（面板与落卡口径一致）。 */
export function bigramSimilarity(a: string, b: string): number {
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i + 2 <= s.length; i += 1) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  let total = 0;
  for (const [, n] of ga) total += n;
  for (const [, n] of gb) total += n;
  if (total === 0) return 1;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  return (2 * overlap) / total;
}
