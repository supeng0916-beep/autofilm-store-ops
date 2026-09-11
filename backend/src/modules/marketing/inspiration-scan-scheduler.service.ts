import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { AiTaskRepository } from '../ai-dispatch/ai-task.repository';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../auth/auth.types';
import { MarketingService } from './marketing.service';

/** 单轮结果：generated=当日是否已了结（含护栏跳过），created=本轮新落候选条数；
 * in-flight=另一轮扫描在途被互斥跳过（P3-F04，不算当日了结） */
export interface InspirationScanRunResult {
  generated: boolean;
  created: number;
  reason?: 'disabled' | 'already-done' | 'candidate-backlog' | 'in-flight' | 'error';
}

/** 待处理候选堆积上限：≥20 条未消化时本轮不再新增（等人处理完再继续扫） */
export const INSPIRATION_SCAN_BACKLOG_LIMIT = 20;

/** 自动扫描的系统身份（createdBy 留痕 + AI 任务 ref）：非真实用户，仅标识来源 */
const SYSTEM_ACTOR: JwtPayload = {
  sub: 'inspiration-scan',
  username: 'inspiration-scan',
  type: 'access',
};

/** 灵感库每日自动扫描（T4，批次B挂账项转正）：手动版周期扫描（批次B Task 2）只回
 * 预览不入库——本服务补自动版：每天定时联网扫一遍爆款公开分析，结果以
 * **candidate 候选态**入库（建议不直接生效，人工在灵感库页签采纳/忽略）。
 *
 * 机制（照同行动态 competitor-daily 成熟模式）：
 * - 每小时巡检 + 启动补跑（门店机不一定在固定时刻开机）：当天未扫且已过 07:00 即扫
 * - 幂等：SystemMeta `inspiration.scan.done.<日期>` 当日只扫一次
 * - 扫描复用手动版 MarketingService.scanInspirations（AI 预算熔断/开关/失败不标记
 *   完成，下小时自动重试——AI 失败当日不算 done）
 * - 防堆积双护栏：①入库前 title 查重（与既有 active+candidate 重复的跳过）；
 *   ②待处理 candidate ≥20 时本轮跳过（等人消化），跳过也算当日完成（写幂等键）
 * - WG_INSPIRATION_SCAN=off 可整体关闭
 * - 不发通知：候选在灵感库页签可见即可（控制打扰成本，设计裁定 5） */
@Injectable()
export class InspirationScanScheduler implements OnModuleInit {
  private readonly logger = new Logger(InspirationScanScheduler.name);

  /** 在途互斥（P3-F04 修复，2026-09-08 phase3 评测实锤）：真实扫描跨 11:00 时整点
   * 巡检重入建了第二个 AI 任务；受控并发复现 2 次调用、2 条同名候选——幂等键在扫描
   * 完成后才写，在途窗口内「当日未扫」判定与 title 查重都不是原子的。进程内 Promise
   * 互斥：单实例部署下巡检/启动补跑/测试直调是唯一触发源（ai-dispatch 的
   * quietLandingNotify 内存集合同款先例）；检查-置位在同一同步段完成（首个 await 前），
   * 单线程事件循环下无竞态窗口。在途跳过不写幂等键——真跑的那轮负责当日了结。 */
  private scanInFlight: Promise<InspirationScanRunResult> | null = null;

  constructor(
    private readonly marketing: MarketingService,
    private readonly tasks: AiTaskRepository,
    private readonly prisma: PrismaService,
  ) {}

  /** 启动补跑（开机晚于扫描窗口也不漏扫）+ 每小时巡检。
   * 测试环境跳过（同 competitor-daily 先例）：补跑在套件 boot 期异步打共享测试库，
   * 会与断言竞态；套件按需显式调 autoScanOnce 验证。 */
  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    void this.autoScanOnce();
  }

  @Cron(CronExpression.EVERY_HOUR)
  hourlyCheck(): void {
    // 07:00 前的整点巡检不扫（等早间信息积累；错过窗口由启动补跑/后续巡检兜底）
    if (new Date().getHours() < 7) return;
    void this.autoScanOnce();
  }

  private disabled(): boolean {
    const v = process.env.WG_INSPIRATION_SCAN?.trim().toLowerCase();
    return v === 'off' || v === '0' || v === 'false';
  }

  private dateKey(d = new Date()): string {
    // 本地日期（门店口径）：年-月-日
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  private doneKey(key: string): string {
    return `inspiration.scan.done.${key}`;
  }

  /** 单轮自动扫描（巡检/启动补跑共用入口，测试直接调）：在途互斥 → runScan。
   * 互斥判定与置位必须在首个 await 前同步完成（见 scanInFlight 注释）。 */
  async autoScanOnce(): Promise<InspirationScanRunResult> {
    if (this.disabled()) return { generated: false, created: 0, reason: 'disabled' };
    if (this.scanInFlight) return { generated: false, created: 0, reason: 'in-flight' };
    const run = this.runScan();
    this.scanInFlight = run;
    try {
      return await run;
    } finally {
      this.scanInFlight = null;
    }
  }

  /** 扫描主体：开关/当日幂等 → 堆积护栏 → AI 扫描（复用手动版）→ title 查重
   * → 批量落 candidate → 写幂等键。AI 失败（熔断/降级/契约不符抛错）不写幂等键，
   * 下小时重试。 */
  private async runScan(): Promise<InspirationScanRunResult> {
    const key = this.dateKey();
    const done = await this.tasks.metaGet(this.doneKey(key));
    if (done) return { generated: false, created: 0, reason: 'already-done' };
    try {
      // 护栏②：待处理候选堆积 → 本轮跳过等人消化；跳过也算当日完成（不再小时级重查）
      const pending = await this.prisma.videoInspiration.count({
        where: { status: 'candidate' },
      });
      if (pending >= INSPIRATION_SCAN_BACKLOG_LIMIT) {
        await this.tasks.metaSet(this.doneKey(key), new Date().toISOString());
        this.logger.log(
          `灵感自动扫描 ${key} 跳过：待处理候选 ${pending} 条 ≥ ${INSPIRATION_SCAN_BACKLOG_LIMIT}，先等人消化`,
        );
        return { generated: true, created: 0, reason: 'candidate-backlog' };
      }

      // 复用手动版扫描（同一 AI 通道，受成本门禁/开关管辖；失败抛错走下方 catch）
      const { items } = await this.marketing.scanInspirations(SYSTEM_ACTOR);

      // 护栏①：title 查重——与既有 active+candidate 同名的不入库（AI 检索结果逐日高度重合）
      const titles = [...new Set(items.map((i) => i.title))];
      const dupRows = await this.prisma.videoInspiration.findMany({
        where: { status: { in: ['active', 'candidate'] }, title: { in: titles } },
        select: { title: true },
      });
      const dupTitles = new Set(dupRows.map((r) => r.title));
      // 本批内同名也只留第一条（AI 偶发同题双条）
      const seen = new Set<string>();
      const fresh = items.filter((i) => {
        if (dupTitles.has(i.title) || seen.has(i.title)) return false;
        seen.add(i.title);
        return true;
      });

      if (fresh.length > 0) {
        await this.prisma.videoInspiration.createMany({
          data: fresh.map((i) => ({
            platform: i.platform,
            title: i.title,
            hookText: i.hookText,
            structure: i.structure,
            rhythm: i.rhythm,
            metrics: i.metrics,
            tags: i.tags,
            isPeer: false,
            sourceUrl: i.sourceUrl,
            status: 'candidate',
            createdBy: SYSTEM_ACTOR.sub,
          })),
        });
      }
      await this.tasks.metaSet(this.doneKey(key), new Date().toISOString());
      this.logger.log(
        `灵感自动扫描 ${key} 完成：AI 返回 ${items.length} 条，查重跳过 ${items.length - fresh.length} 条，新落候选 ${fresh.length} 条`,
      );
      return { generated: true, created: fresh.length };
    } catch (err) {
      this.logger.warn(
        `灵感自动扫描失败（将于下小时重试）：${err instanceof Error ? err.message : String(err)}`,
      );
      return { generated: false, created: 0, reason: 'error' };
    }
  }
}
