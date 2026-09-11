import { execFile } from 'node:child_process';

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';

/** 心跳消息发送器抽象（批次5 心跳）：生产=exec openclaw message send（经腾讯官方
 * openclaw-weixin 插件走个人微信单聊）；测试注入 fake。 */
export type HeartbeatSender = (text: string) => Promise<void>;

/** 生产发送器：CLI 子进程调用，15s 超时。目标微信 ID 取 WG_HEARTBEAT_WEIXIN_TO——
 * 部署时配置（老板先给网关微信发条消息完成配对并取得 target，见部署文档）。 */
export function openclawWeixinSender(target: string): HeartbeatSender {
  return (text) =>
    new Promise<void>((resolve, reject) => {
      execFile(
        'openclaw',
        ['message', 'send', '--channel', 'openclaw-weixin', '--target', target, '-m', text],
        { timeout: 15_000 },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(`openclaw message send 失败：${stderr || err.message}`));
            return;
          }
          resolve();
        },
      );
    });
}

/** 每日脱敏心跳（批次5 心跳，2026-09-03 与产品经理拍板改走 OpenClaw 微信渠道）：
 * - 内容=纯聚合数字零客户数据（红线不变）：系统健康自检+今日客资+待办四项+AI 成本水位
 * - 机制沿经营晨报：每小时巡检（≥08:00）+启动补跑+SystemMeta `heartbeat.done.<日期>` 幂等；
 *   发送失败不写幂等键，下小时自动重试（宁重发不漏发——重复心跳无害，漏发违背初衷）
 * - WG_HEARTBEAT=off 整体关闭；WG_HEARTBEAT_WEIXIN_TO 缺省时只记日志不发送（部署前安全态）
 * - 渠道注意：openclaw-weixin 仅单聊（无群聊）、网关需在线；凭据本地存储（腾讯官方插件） */
@Injectable()
export class HeartbeatService implements OnModuleInit {
  private readonly logger = new Logger(HeartbeatService.name);
  private sender: HeartbeatSender | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** SystemMeta 读写（沿 ai-task.repository 同口径；不依赖 ai-dispatch 防全局模块循环） */
  private async metaGet(key: string): Promise<string | null> {
    const row = await this.prisma.systemMeta.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  private async metaSet(key: string, value: string): Promise<void> {
    await this.prisma.systemMeta.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  /** 测试/替换发送器入口 */
  setSender(sender: HeartbeatSender | null): void {
    this.sender = sender;
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    const target = process.env.WG_HEARTBEAT_WEIXIN_TO?.trim();
    if (target) this.sender = openclawWeixinSender(target);
    else this.logger.warn('未配置 WG_HEARTBEAT_WEIXIN_TO，心跳将只记日志不发送');
    void this.runIfDue();
  }

  @Cron(CronExpression.EVERY_HOUR)
  hourlyCheck(): void {
    if (new Date().getHours() < 8) return;
    void this.runIfDue();
  }

  private disabled(): boolean {
    const v = process.env.WG_HEARTBEAT?.trim().toLowerCase();
    return v === 'off' || v === '0' || v === 'false';
  }

  private dateKey(d = new Date()): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  async runIfDue(): Promise<{ sent: boolean; reason?: string }> {
    if (this.disabled()) return { sent: false, reason: 'disabled' };
    const key = this.dateKey();
    const done = await this.metaGet(`heartbeat.done.${key}`);
    if (done) return { sent: false, reason: 'already-done' };
    const text = await this.compose();
    try {
      if (this.sender) await this.sender(text);
      else this.logger.log(`心跳（未配发送目标，仅日志）：\n${text}`);
    } catch (err) {
      this.logger.warn(
        `心跳发送失败（下小时重试）：${err instanceof Error ? err.message : String(err)}`,
      );
      return { sent: false, reason: 'send-error' };
    }
    // 成功后才写幂等键（失败重发无害、漏发有害）
    await this.metaSet(`heartbeat.done.${key}`, new Date().toISOString());
    return { sent: true };
  }

  /** 聚合纯数字（零客户数据）：自检健康 + 今日客资 + 待办四项 + AI 成本水位 */
  async compose(): Promise<string> {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = new Date(dayStart.getTime() + 86_399_999);
    const [newLeads, pendingApprovals, draftOrders, dueFollowups, overdue, aiCostRows, failing] =
      await Promise.all([
        this.prisma.lead.count({ where: { createdAt: { gte: dayStart } } }),
        this.prisma.approvalItem.count({ where: { status: 'pending' } }),
        this.prisma.orderConfirmation.count({ where: { status: 'draft' } }),
        this.prisma.lead.count({
          where: { finalStatus: 'active', nextFollowUpAt: { gte: dayStart, lte: dayEnd } },
        }),
        this.prisma.lead.count({
          where: { finalStatus: 'active', nextFollowUpAt: { lt: now } },
        }),
        this.prisma.aiTask.aggregate({
          where: { createdAt: { gte: dayStart } },
          _sum: { costEstimateFen: true },
        }),
        this.prisma.aiTask.count({
          where: {
            status: { in: ['failed', 'degraded'] },
            createdAt: { gte: new Date(dayStart.getTime() - 86_400_000) },
          },
        }),
      ]);
    const aiFen = aiCostRows._sum.costEstimateFen ?? 0;
    const budgetFen = Number(process.env.WG_AI_DAILY_BUDGET_FEN ?? 10000);
    const healthy = failing < 10; // 近 24h 异常任务 ≥10 视为系统异常（粗口径，仅聚合数字）
    const lines = [
      `【门店系统心跳】${this.dateKey()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      `系统${healthy ? '正常' : '异常（近24h AI 失败任务 ' + failing + ' 个，请检查）'}`,
      `今日新客资 ${newLeads} 条；待审批 ${pendingApprovals} 项；待确认订单 ${draftOrders} 单`,
      `该跟进 ${dueFollowups} 条${overdue > 0 ? `（另有超期 ${overdue} 条）` : ''}`,
      `AI 成本 ¥${(aiFen / 100).toFixed(2)} / ¥${(budgetFen / 100).toFixed(0)}`,
    ];
    return lines.join('\n');
  }
}
