import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';
import { ASSIGN_META_KEYS, AssignService, isWalkInLead } from './assign.service';
import { LEAD_EVENT_KIND } from './lead.constants';
import { LeadRepository } from './lead.repository';

/** 营业时间（D-P3-5）：'HH:mm' 字符串，纯函数时钟配置 */
export interface BusinessHours {
  start: string;
  end: string;
}

/** SLA 阈值（营业分钟）：提醒/违约/升级，SystemMeta 可配，缺省占位默认 */
export interface SlaThresholds {
  remind: number;
  breach: number;
  escalate: number;
}

/** SLA 运行时配置：营业时间 + 阈值 */
export interface SlaConfig {
  hours: BusinessHours;
  thresholds: SlaThresholds;
}

/** SLA 派生状态：ok 计时中 / remind 已提醒 / breach 已违约 / escalate 已升级 / done 已触达 / na 不适用 */
export type SlaState = 'ok' | 'remind' | 'breach' | 'escalate' | 'done' | 'na';

/** GET /leads 返回体 sla 派生字段：倒计时以违约阈值（breach）为截止，done/na 时为 null */
export interface LeadSla {
  state: SlaState;
  dueInMinutes: number | null;
}

/** SystemMeta SLA 配置键（D-P3-5）：营业时间 + 三级阈值 */
export const SLA_META_KEYS = {
  businessHours: 'sla.business.hours',
  remind: 'sla.remind.minutes',
  breach: 'sla.breach.minutes',
  escalate: 'sla.escalate.minutes',
} as const;

const DEFAULT_BUSINESS_HOURS_RAW = '09:00-19:00';
const DEFAULT_BUSINESS_HOURS: BusinessHours = { start: '09:00', end: '19:00' };
const DEFAULT_REMIND_MINUTES = 20;
const DEFAULT_BREACH_MINUTES = 30;
const DEFAULT_ESCALATE_MINUTES = 60;
const DEFAULT_BOSS = 'ph-boss';

const HHMM_RE = /^\d{2}:\d{2}$/;

/** 解析 'HH:mm-HH:mm' → BusinessHours；格式非法返回 null（调用方回退默认，不静默吞） */
export function parseBusinessHours(value: string): BusinessHours | null {
  const [start, end] = value.split('-');
  if (!start || !end || !HHMM_RE.test(start) || !HHMM_RE.test(end)) return null;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if (sh < 0 || sh > 23 || sm < 0 || sm > 59 || eh < 0 || eh > 23 || em < 0 || em > 59) {
    return null;
  }
  return { start, end };
}

/** 'HH:mm' → [hour, minute]（内部，入参已由 HHMM_RE 校验） */
function parseHHmm(hhmm: string): [number, number] {
  const [h, m] = hhmm.split(':').map(Number);
  return [h, m];
}

/** 当天该时刻的 Date（不改入参；本地时区，与 receivedAt 一致） */
function atTime(date: Date, hhmm: string): Date {
  const [h, m] = parseHHmm(hhmm);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

/** 次日 open 时刻的 Date */
function atNextDayOpen(date: Date, open: string): Date {
  const d = atTime(date, open);
  d.setDate(d.getDate() + 1);
  return d;
}

/** 营业分钟纯函数：只累加营业区间内的分钟，跨日/跨非营业段正确（D-P3-5）。
 * 无副作用；start ≥ end 返回 0。营业时间不跨夜（open < close，默认 09:00-19:00）。 */
export function businessMinutesBetween(start: Date, end: Date, hours: BusinessHours): number {
  let minutes = 0;
  const cursor = new Date(start);
  while (cursor < end) {
    const dayOpen = atTime(cursor, hours.start);
    const dayClose = atTime(cursor, hours.end);
    const segStart = cursor < dayOpen ? dayOpen : cursor;
    const segEnd = end < dayClose ? end : dayClose;
    if (segStart < segEnd) {
      minutes += Math.round((segEnd.getTime() - segStart.getTime()) / 60000);
    }
    cursor.setTime(atNextDayOpen(cursor, hours.start).getTime());
  }
  return minutes;
}

/** SLA 派生字段纯函数：仅非到店、活跃、新线索且未首次触达计时；倒计时以违约阈值为截止 */
export function computeSla(
  lead: {
    receivedAt: Date;
    firstContactAttemptAt: Date | null;
    finalStatus: string;
    stage: string;
    sourcePlatform: string;
    acquisitionMethod: string | null;
  },
  now: Date,
  config: SlaConfig,
): LeadSla {
  if (lead.firstContactAttemptAt) return { state: 'done', dueInMinutes: null };
  if (lead.finalStatus !== 'active' || lead.stage !== 'new') {
    return { state: 'na', dueInMinutes: null };
  }
  if (
    isWalkInLead({ sourcePlatform: lead.sourcePlatform, acquisitionMethod: lead.acquisitionMethod })
  ) {
    return { state: 'na', dueInMinutes: null };
  }
  const elapsed = businessMinutesBetween(lead.receivedAt, now, config.hours);
  if (elapsed >= config.thresholds.escalate) return { state: 'escalate', dueInMinutes: 0 };
  if (elapsed >= config.thresholds.breach) return { state: 'breach', dueInMinutes: 0 };
  const due = Math.max(0, config.thresholds.breach - elapsed);
  return { state: elapsed >= config.thresholds.remind ? 'remind' : 'ok', dueInMinutes: due };
}

/** SLA 营业分钟时钟（P3-03）：每分钟扫描活跃新线索，按营业分钟触发提醒/违约/升级三级事件。
 * cron 是薄壳，核心 tick(now) 公开供测试直接驱动；事件同类幂等，升级自动改派老板兜底。 */
@Injectable()
export class SlaService {
  private readonly logger = new Logger(SlaService.name);

  constructor(
    private readonly repo: LeadRepository,
    private readonly prisma: PrismaService,
    private readonly assign: AssignService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async cronTick(): Promise<void> {
    await this.tick(new Date());
  }

  /** 一轮 SLA 扫描：查候选→逐条算营业分钟→阈值事件（同类去重）→升级改派；返回本轮触发事件数 */
  async tick(now: Date = new Date()): Promise<number> {
    const config = await this.loadConfig();
    const candidates = (await this.repo.findSlaCandidates()).filter(
      (lead) =>
        !isWalkInLead({
          sourcePlatform: lead.sourcePlatform,
          acquisitionMethod: lead.acquisitionMethod,
        }),
    );

    let handled = 0;
    for (const lead of candidates) {
      const minutes = businessMinutesBetween(lead.receivedAt, now, config.hours);
      if (minutes >= config.thresholds.escalate) {
        if (await this.repo.eventExists(lead.id, LEAD_EVENT_KIND.SLA_ESCALATE)) continue;
        await this.repo.appendEvent(lead.id, LEAD_EVENT_KIND.SLA_ESCALATE, { minutes });
        await this.escalateToBoss(lead.id);
        handled++;
      } else if (minutes >= config.thresholds.breach) {
        if (await this.repo.eventExists(lead.id, LEAD_EVENT_KIND.SLA_BREACH)) continue;
        await this.repo.appendEvent(lead.id, LEAD_EVENT_KIND.SLA_BREACH, { minutes });
        handled++;
      } else if (minutes >= config.thresholds.remind) {
        if (await this.repo.eventExists(lead.id, LEAD_EVENT_KIND.SLA_REMIND)) continue;
        await this.repo.appendEvent(lead.id, LEAD_EVENT_KIND.SLA_REMIND, { minutes });
        handled++;
      }
    }
    return handled;
  }

  /** 读取 SLA 配置（营业时间 + 阈值），供 cron 与队列页 sla 派生字段共用 */
  async loadConfig(): Promise<SlaConfig> {
    const raw = await this.readMeta(SLA_META_KEYS.businessHours, DEFAULT_BUSINESS_HOURS_RAW);
    const hours = parseBusinessHours(raw) ?? DEFAULT_BUSINESS_HOURS;
    const remind = await this.readIntMeta(SLA_META_KEYS.remind, DEFAULT_REMIND_MINUTES);
    const breach = await this.readIntMeta(SLA_META_KEYS.breach, DEFAULT_BREACH_MINUTES);
    const escalate = await this.readIntMeta(SLA_META_KEYS.escalate, DEFAULT_ESCALATE_MINUTES);
    return { hours, thresholds: { remind, breach, escalate } };
  }

  /** 升级兜底：改派老板（forceAssign 无会话主体）；老板账号缺映射时只 warn 不阻断 */
  private async escalateToBoss(leadId: string): Promise<void> {
    const bossUsername = await this.readMeta(ASSIGN_META_KEYS.boss, DEFAULT_BOSS);
    const bossUserId = await this.repo.findUserIdByUsername(bossUsername);
    if (!bossUserId) {
      this.logger.warn(`SLA 升级改派老板失败：username=${bossUsername} 无账号映射`);
      return;
    }
    await this.assign.forceAssign(leadId, bossUserId, 'SLA升级老板兜底');
  }

  private async readMeta(key: string, fallback: string): Promise<string> {
    const meta = await this.prisma.systemMeta.findUnique({ where: { key } });
    return meta && meta.value ? meta.value : fallback;
  }

  private async readIntMeta(key: string, fallback: number): Promise<number> {
    const meta = await this.prisma.systemMeta.findUnique({ where: { key } });
    if (!meta) return fallback;
    const n = Number(meta.value);
    return Number.isInteger(n) ? n : fallback;
  }
}
