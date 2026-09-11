import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { AiDispatchService } from '../ai-dispatch/ai-dispatch.service';
import { AiTaskRepository } from '../ai-dispatch/ai-task.repository';
import { exceedsAsciiDensity, hasCjkText } from '../ai-dispatch/output-lint';
import { PrismaService } from '../../prisma/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';

/** 同行动态每日推送（2026-08-27 老板需求：使用者不会主动问 AI——改为每天自动搜索整理，
 * 任何员工当天第一次打开系统，通知铃铛红点里就是这份日报）。
 *
 * 采集口径（口径 A 合规，2026-08-18 拍板不变）：**定时联网搜索**（复用 skill-sales-agent
 * 已批的 web_search 通道，搜公开网页），**不做**平台爬取/批量采集/账号自动化。
 *
 * 机制：
 * - 每小时巡检 + 启动补跑（门店机不一定在固定时刻开机）：当天未生成且已过 07:00 即生成
 * - 幂等：SystemMeta `competitor.daily.done.<日期>` 当日只发一次；正文另存
 *   `competitor.daily.content.<日期>` 供复看
 * - 生成走 submitTaskAutoRetry（AI 预算熔断/失败不标记完成，下小时自动重试）
 * - WG_COMPETITOR_DAILY=off 可整体关闭；查询词可用 WG_COMPETITOR_DAILY_QUERY 覆盖 */
@Injectable()
export class CompetitorDailyService implements OnModuleInit {
  private readonly logger = new Logger(CompetitorDailyService.name);

  constructor(
    private readonly dispatch: AiDispatchService,
    private readonly tasks: AiTaskRepository,
    private readonly prisma: PrismaService,
  ) {}

  /** 启动补跑（开机晚于生成窗口也不漏发）+ 每小时巡检。
   * 测试环境跳过（2026-08-28）：补跑在每个套件 boot 期异步打共享测试库，曾与断言竞态
   * 造成整套 rbac 92 用例连锁失败；套件按需显式调 runIfDue 验证。 */
  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    void this.runIfDue();
  }

  @Cron(CronExpression.EVERY_HOUR)
  hourlyCheck(): void {
    // 07:00 前的整点巡检不生成（等早间信息积累；错过窗口由启动补跑/后续巡检兜底）
    if (new Date().getHours() < 7) return;
    void this.runIfDue();
  }

  private disabled(): boolean {
    const v = process.env.WG_COMPETITOR_DAILY?.trim().toLowerCase();
    return v === 'off' || v === '0' || v === 'false';
  }

  private dateKey(d = new Date()): string {
    // 本地日期（门店口径）：年-月-日
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** 巡检/启动/手动入口：当天未生成即生成。时刻闸门只在 hourlyCheck（2026-08-28 修正：
   * 原 runIfDue 内含 hour<7 判断，凌晨跑测试/开机补跑会被误跳过——启动补跑不应受时刻限制） */
  async runIfDue(): Promise<{ generated: boolean; reason?: string }> {
    if (this.disabled()) return { generated: false, reason: 'disabled' };
    const key = this.dateKey();
    const done = await this.tasks.metaGet(`competitor.daily.done.${key}`);
    if (done) return { generated: false, reason: 'already-done' };
    try {
      await this.generate(key);
      return { generated: true };
    } catch (err) {
      this.logger.warn(
        `同行动态日报生成失败（将于下小时重试）：${err instanceof Error ? err.message : String(err)}`,
      );
      return { generated: false, reason: 'error' };
    }
  }

  /** 手动触发（boss 硬校验）：与巡检同幂等键——当天已生成则返回既有内容不重复发 */
  async runManual(actor: {
    sub: string;
    username: string;
  }): Promise<{ generated: boolean; date: string; content: string | null }> {
    const roles = await this.tasks.userRoleCodes(actor.sub);
    if (!roles.includes('boss')) {
      throw new AppException(ErrorCode.PERM_DENIED, '仅老板可手动触发生成');
    }
    const key = this.dateKey();
    const done = await this.tasks.metaGet(`competitor.daily.done.${key}`);
    if (done) {
      return {
        generated: false,
        date: key,
        content: await this.tasks.metaGet(`competitor.daily.content.${key}`),
      };
    }
    await this.generate(key);
    return {
      generated: true,
      date: key,
      content: await this.tasks.metaGet(`competitor.daily.content.${key}`),
    };
  }

  private async generate(dateKey: string): Promise<void> {
    const query =
      process.env.WG_COMPETITOR_DAILY_QUERY?.trim() ||
      '联网搜索最近一天本地汽车贴膜/窗膜行业动态与同城同行公开活动（新店开业/优惠促销/新品发布/行业新闻），整理成给门店员工看的日报：最多 5 条要点，每条带来源；没有值得关注的就明确说今日无重要动态，不要编造。';
    // 复用已批的 skill-sales-agent 通道（persona=sales 才有 web_search 权限；staff 用系统标识）
    const task = await this.dispatch.submitTaskAutoRetry(
      'sales.agent.chat',
      { persona: 'sales', staff: 'system-daily', message: query },
      { type: 'system', id: `competitor-daily-${dateKey}` },
    );
    if (task.status !== 'done' || !task.output) {
      throw new Error(`AI 任务未成功（status=${task.status}）`);
    }
    const rawReply = (task.output as { reply?: unknown }).reply;
    const reply = (typeof rawReply === 'string' ? rawReply : '').trim();
    const content = extractChineseDigest(reply);
    if (!content) {
      // 2026-08-28 实况：模型把英文思维链当正文输出（1499 字中文仅 3%）——判失败走小时重试，
      // 绝不把英文思考过程推给门店员工
      throw new Error('AI 输出中文占比不足（疑似思维链泄漏），已拒绝推送');
    }

    // 全员通知（在职用户人手一条未读 → 各自首开页面见红点；已读互不影响）
    const users = await this.prisma.user.findMany({
      where: { disabled: false },
      select: { id: true },
    });
    if (users.length > 0) {
      await this.prisma.notification.createMany({
        data: users.map((u) => ({
          userId: u.id,
          kind: 'competitor.daily',
          title: `同行动态日报 ${dateKey}`,
          body: content,
          sourceType: 'competitor-daily',
          sourceId: dateKey,
        })),
      });
    }
    // 标记完成 + 存正文（先发通知后标记：标记失败最多下小时重发一次，宁重勿漏）
    await this.tasks.metaSet(`competitor.daily.content.${dateKey}`, content);
    await this.tasks.metaSet(`competitor.daily.done.${dateKey}`, new Date().toISOString());
    this.logger.log(`同行动态日报 ${dateKey} 已推送（${users.length} 人）`);
  }
}

/** 日报中文抽取（2026-08-28 Q1，两轮修正）：三级清洗——
 * ①行级：丢弃整行无中文的行（英文思维链整行）；
 * ②句级：行内按句末标点切句，丢弃无中文的句子（中文短句后粘的英文思考句）；
 * ③密度：结果 <20 字或英文字母占比 >45%（剩余内容仍以英文为主）→ 空串拒收。
 * 汉字有无/字母密度判据 2026-09-04 Task3 归一：改由 output-lint 导出的
 * hasCjkText/exceedsAsciiDensity 承载（与 R1 同一来源），本函数只保留清洗重组职能。 */
export function extractChineseDigest(reply: string): string {
  const lines = reply
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && hasCjkText(l))
    .map((l) =>
      l
        .split(/(?<=[。！？])(?=\S)|(?<=[.!?])\s+/) // 全角句末直接切（中文句后紧粘英文无空格实况）；ASCII 句点须后随空白（防 URL 误切）
        .filter((s) => hasCjkText(s))
        .join(''),
    )
    .filter((l) => l.length > 0);
  const text = lines.join('\n').slice(0, 1500);
  if (text.length < 20 || exceedsAsciiDensity(text)) return '';
  return text;
}
