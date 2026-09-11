import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';
import { AiDispatchService } from '../ai-dispatch/ai-dispatch.service';
import { AiTaskRepository } from '../ai-dispatch/ai-task.repository';
import { BossAggregator } from './aggregators/boss.aggregator';
import { serializeStructuredContext } from './aggregators/role-context';
import { PersonaService } from './persona.service';

/** 经营晨报（V1.5 批次2，spec §8）：老板每天早上一页纸——复用 BossAggregator（同一套经营
 * 快照）与 skill-boss-agent（AI 侧零新技能，taskType 独立便于成本统计与开关）。
 *
 * 机制（沿同行动态日报 2026-08-27 模式）：
 * - 每小时巡检 + 启动补跑（门店机不一定固定时刻开机——关机错过 07:00 开机即补）
 * - 幂等：SystemMeta `boss.brief.done.<日期>` 当日只发一次；正文存
 *   `boss.brief.content.<日期>` 供复看（SystemMeta 进备份，复看链路同 competitor.daily）
 * - 推送目标 = boss 角色用户 ∪ persona 映射为 boss 的用户（老板娘，spec §3.2）
 * - WG_BOSS_BRIEF=off 可整体关闭 */
@Injectable()
export class MorningBriefService implements OnModuleInit {
  private readonly logger = new Logger(MorningBriefService.name);

  constructor(
    private readonly dispatch: AiDispatchService,
    private readonly tasks: AiTaskRepository,
    private readonly prisma: PrismaService,
    private readonly bossAggregator: BossAggregator,
    private readonly persona: PersonaService,
  ) {}

  /** 启动补跑（开机晚于 07:00 不漏发）；测试环境跳过（同 competitor-daily 口径） */
  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    void this.runIfDue();
  }

  @Cron(CronExpression.EVERY_HOUR)
  hourlyCheck(): void {
    if (new Date().getHours() < 7) return; // 早 7 点前的巡检不生成
    void this.runIfDue();
  }

  private disabled(): boolean {
    const v = process.env.WG_BOSS_BRIEF?.trim().toLowerCase();
    return v === 'off' || v === '0' || v === 'false';
  }

  private dateKey(d = new Date()): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** 巡检/启动/手动入口：当天未生成即生成（时刻闸门只在 hourlyCheck） */
  async runIfDue(): Promise<{ generated: boolean; reason?: string }> {
    if (this.disabled()) return { generated: false, reason: 'disabled' };
    const key = this.dateKey();
    const done = await this.tasks.metaGet(`boss.brief.done.${key}`);
    if (done) return { generated: false, reason: 'already-done' };
    try {
      await this.generate(key);
      return { generated: true };
    } catch (err) {
      this.logger.warn(
        `经营晨报生成失败（将于下小时重试）：${err instanceof Error ? err.message : String(err)}`,
      );
      return { generated: false, reason: 'error' };
    }
  }

  /** 手动触发（boss∪sys_admin 角色硬校验，沿 persona-map 先例）：当天已生成返回既有内容 */
  async runManual(
    actor: import('../auth/auth.types').JwtPayload,
  ): Promise<{ generated: boolean; date: string; content: string | null }> {
    await this.persona.assertBossOrAdmin(actor);
    const key = this.dateKey();
    const done = await this.tasks.metaGet(`boss.brief.done.${key}`);
    if (done) {
      return {
        generated: false,
        date: key,
        content: await this.tasks.metaGet(`boss.brief.content.${key}`),
      };
    }
    await this.generate(key);
    return {
      generated: true,
      date: key,
      content: await this.tasks.metaGet(`boss.brief.content.${key}`),
    };
  }

  /** 推送目标：boss 角色在职用户 ∪ persona 映射为 boss 的用户（去重） */
  async recipients(): Promise<string[]> {
    const [bossUsers, personaMap] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { role: { code: 'boss' }, user: { disabled: false } },
        select: { userId: true },
      }),
      this.persona.readMap(),
    ]);
    const ids = new Set(bossUsers.map((r) => r.userId));
    for (const [userId, p] of Object.entries(personaMap)) {
      if (p === 'boss') ids.add(userId);
    }
    // 映射用户可能已停用：过滤
    if (ids.size > 0) {
      const active = await this.prisma.user.findMany({
        where: { id: { in: [...ids] }, disabled: false },
        select: { id: true },
      });
      return active.map((u) => u.id);
    }
    return [];
  }

  private async generate(dateKey: string): Promise<void> {
    // 聚合快照：以任一 boss 用户为 actor（权限过滤需要——拿全区块；无 boss 用户时 aiOps 自动缺省）
    const bossRow = await this.prisma.userRole.findFirst({
      where: { role: { code: 'boss' }, user: { disabled: false } },
      select: { userId: true, user: { select: { username: true } } },
    });
    const actor = bossRow
      ? { sub: bossRow.userId, username: bossRow.user.username, type: 'access' as const }
      : { sub: 'system-brief', username: 'system-brief', type: 'access' as const };
    const blocks = await this.bossAggregator.collect(actor);
    const structuredContext = serializeStructuredContext(blocks);
    const task = await this.dispatch.submitTaskAutoRetry(
      'boss.morning_brief',
      {
        persona: 'boss',
        staff: 'system-brief',
        message:
          '生成今天的经营晨报：按 structuredContext 用人话总结待拍板事项、跟进到期、AI 水位，结论先行、按优先级排，给建议动作；空区块如实说暂无。控制在 300 字内，纯文本。',
        structuredContext,
      },
      { type: 'system', id: `boss-brief-${dateKey}` },
    );
    if (task.status !== 'done' || !task.output) {
      throw new Error(`AI 任务未成功（status=${task.status}）`);
    }
    const rawReply = (task.output as { reply?: unknown }).reply;
    const content = (typeof rawReply === 'string' ? rawReply : '').trim();
    if (!content) throw new Error('晨报输出为空，已拒绝推送');

    const userIds = await this.recipients();
    if (userIds.length > 0) {
      await this.prisma.notification.createMany({
        data: userIds.map((userId) => ({
          userId,
          kind: 'boss.morning_brief',
          title: `经营晨报 ${dateKey}`,
          body: content.slice(0, 2000),
          sourceType: 'morning-brief',
          sourceId: dateKey,
        })),
      });
    }
    // 先发通知后标记（标记失败最多下小时重发一次，宁重勿漏——competitor-daily 同口径）
    await this.tasks.metaSet(`boss.brief.content.${dateKey}`, content);
    await this.tasks.metaSet(`boss.brief.done.${dateKey}`, new Date().toISOString());
    this.logger.log(`经营晨报 ${dateKey} 已推送（${userIds.length} 人）`);
  }
}
