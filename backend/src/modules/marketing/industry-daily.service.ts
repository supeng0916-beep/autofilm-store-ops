import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';
import { AiDispatchService } from '../ai-dispatch/ai-dispatch.service';
import { AiTaskRepository } from '../ai-dispatch/ai-task.repository';
import { PersonaService } from '../agent/persona.service';

import { extractChineseDigest } from './competitor-daily.service';

/** 行业晨报（V1.5 批次4，spec §8）：贴膜行业动态/演示品牌品牌新闻/本地消费趋势资讯简报。
 * 复用同行动态日报（2026-08-27）的全部机制：每小时巡检+启动补跑+SystemMeta 幂等+
 * web_search 通道（口径 A 合规，不新接搜索渠道——成本增量计入日限额）。
 * 受众差异：同行日报全员、行业晨报推老板（boss 角色 ∪ persona 映射 boss）。
 * WG_INDUSTRY_DAILY=off 可整体关闭。 */
@Injectable()
export class IndustryDailyService implements OnModuleInit {
  private readonly logger = new Logger(IndustryDailyService.name);

  constructor(
    private readonly dispatch: AiDispatchService,
    private readonly tasks: AiTaskRepository,
    private readonly prisma: PrismaService,
    private readonly persona: PersonaService,
  ) {}

  /** 启动补跑（开机晚于生成窗口不漏发）；测试环境跳过（同 competitor-daily 口径） */
  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    void this.runIfDue();
  }

  @Cron(CronExpression.EVERY_HOUR)
  hourlyCheck(): void {
    if (new Date().getHours() < 7) return;
    void this.runIfDue();
  }

  private disabled(): boolean {
    const v = process.env.WG_INDUSTRY_DAILY?.trim().toLowerCase();
    return v === 'off' || v === '0' || v === 'false';
  }

  private dateKey(d = new Date()): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** 供测试取当日幂等键 */
  currentKey(): string {
    return this.dateKey();
  }

  /** 巡检/启动入口：当天未生成即生成（时刻闸门只在 hourlyCheck） */
  async runIfDue(): Promise<{ generated: boolean; reason?: string }> {
    if (this.disabled()) return { generated: false, reason: 'disabled' };
    const key = this.dateKey();
    const done = await this.tasks.metaGet(`industry.daily.done.${key}`);
    if (done) return { generated: false, reason: 'already-done' };
    try {
      await this.generate(key);
      return { generated: true };
    } catch (err) {
      this.logger.warn(
        `行业晨报生成失败（将于下小时重试）：${err instanceof Error ? err.message : String(err)}`,
      );
      return { generated: false, reason: 'error' };
    }
  }

  /** 推送目标：boss 角色在职用户 ∪ persona 映射为 boss（老板娘），停用过滤 */
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
    if (ids.size === 0) return [];
    const active = await this.prisma.user.findMany({
      where: { id: { in: [...ids] }, disabled: false },
      select: { id: true },
    });
    return active.map((u) => u.id);
  }

  private async generate(dateKey: string): Promise<void> {
    const query =
      process.env.WG_INDUSTRY_DAILY_QUERY?.trim() ||
      '联网搜索最近一天汽车贴膜/窗膜行业动态、演示品牌（DEMO BRAND）品牌新闻、本地本地汽车消费趋势（政策/补贴/市场活动），整理成给门店老板看的简报：最多 5 条要点，每条带来源并注明「来自公开网络，仅供参考」；没有值得关注的就明确说今日无重要动态，不要编造。';
    const task = await this.dispatch.submitTaskAutoRetry(
      'sales.agent.chat',
      { persona: 'sales', staff: 'system-industry', message: query },
      { type: 'system', id: `industry-daily-${dateKey}` },
    );
    if (task.status !== 'done' || !task.output) {
      throw new Error(`AI 任务未成功（status=${task.status}）`);
    }
    const rawReply = (task.output as { reply?: unknown }).reply;
    const reply = (typeof rawReply === 'string' ? rawReply : '').trim();
    // 中文抽取（同 competitor-daily：拒绝英文思维链泄漏）
    const content = extractChineseDigest(reply);
    if (!content) throw new Error('行业简报中文占比不足（疑似思维链泄漏），已拒绝推送');

    const userIds = await this.recipients();
    if (userIds.length > 0) {
      await this.prisma.notification.createMany({
        data: userIds.map((userId) => ({
          userId,
          kind: 'industry.daily',
          title: `行业晨报 ${dateKey}`,
          body: content.slice(0, 2000),
          sourceType: 'industry-daily',
          sourceId: dateKey,
        })),
      });
    }
    await this.tasks.metaSet(`industry.daily.content.${dateKey}`, content);
    await this.tasks.metaSet(`industry.daily.done.${dateKey}`, new Date().toISOString());
    this.logger.log(`行业晨报 ${dateKey} 已推送（${userIds.length} 人）`);
  }
}
