import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Lead, Prisma } from '@prisma/client';

import { LEAD_EVENT_KIND } from './lead.constants';
import { LeadRepository } from './lead.repository';
import { LEAD_FINAL_STATUS, LEAD_SILENCE_STAGE } from './lead.states';

/** 沉默链四档阈值（毫秒）：24h/72h/7d/14d（D-P3 字段字典 §4 / P3-04） */
const H24 = 24 * 60 * 60 * 1000;
const H72 = 72 * 60 * 60 * 1000;
const D7 = 7 * 24 * 60 * 60 * 1000;
const D14 = 14 * 24 * 60 * 60 * 1000;

/** 沉默推进步：advance=升档（可带 finalStatus），remind=14 天流失提醒（不自动判流失） */
interface SilenceStep {
  kind: 'advance' | 'remind';
  silenceStage?: string;
  finalStatus?: string;
}

/**
 * 沉默链（P3-04）：每小时第 7 分扫描活跃未暂停客资，按「最后联系距今」逐档推进（只升档不跳档）。
 * 24h→risk、72h→follow_due、7d→nurture＋finalStatus=silence；14d 不自动判流失，仅 churn_remind_14d 提醒。
 * 显式状态机代码（A02）：沉默判定全由阈值与当前档决定，模型输出无权改状态。
 */
@Injectable()
export class SilenceService {
  constructor(private readonly repo: LeadRepository) {}

  @Cron('0 7 * * * *')
  async cronTick(): Promise<void> {
    await this.tick(new Date());
  }

  /** 一轮沉默扫描：逐条算最后联系距今→按当前档推进一档；返回本轮触发数。 */
  async tick(now: Date = new Date()): Promise<number> {
    const candidates = await this.repo.findSilenceCandidates();
    let handled = 0;
    for (const lead of candidates) {
      const lastContact = lastContactAt(lead);
      if (!lastContact) continue;
      const step = nextSilenceStep(lead.silenceStage, now.getTime() - lastContact.getTime());
      if (!step) continue;

      if (step.kind === 'remind') {
        if (await this.repo.eventExists(lead.id, LEAD_EVENT_KIND.CHURN_REMIND_14D)) continue;
        await this.repo.appendEvent(lead.id, LEAD_EVENT_KIND.CHURN_REMIND_14D, { days: 14 });
        handled++;
        continue;
      }

      // 升档：条件迁移（silenceStage=当前档且仍 active）防复活竞态
      const data: Prisma.LeadUncheckedUpdateInput = { silenceStage: step.silenceStage };
      if (step.finalStatus) data.finalStatus = step.finalStatus;
      const count = await this.repo.updateIfSilenceStage(lead.id, lead.silenceStage, data);
      if (count === 0) continue; // 已被复活/并发推进
      await this.repo.appendEvent(lead.id, LEAD_EVENT_KIND.SILENCE_MARKED, {
        stage: step.silenceStage,
      });
      handled++;
    }
    return handled;
  }

  /** 复活（新消息驱动）：清沉默档、finalStatus 若 silence 回 active、回原 owner（不变）、无冷却期。 */
  async reviveIfApplicable(lead: Lead): Promise<boolean> {
    const silenced =
      lead.finalStatus === LEAD_FINAL_STATUS.SILENCE ||
      lead.silenceStage !== LEAD_SILENCE_STAGE.NONE;
    if (!silenced) return false;
    const data: Prisma.LeadUncheckedUpdateInput = { silenceStage: LEAD_SILENCE_STAGE.NONE };
    if (lead.finalStatus === LEAD_FINAL_STATUS.SILENCE) data.finalStatus = LEAD_FINAL_STATUS.ACTIVE;
    await this.repo.update(lead.id, data);
    await this.repo.appendEvent(lead.id, LEAD_EVENT_KIND.REVIVED, {
      fromSilenceStage: lead.silenceStage,
      fromFinalStatus: lead.finalStatus,
    });
    return true;
  }
}

/** 最后联系时间：firstCustomerReplyAt/lastFollowUpAt 较大者；两者皆空返回 null（尚无客户互动基线）。 */
function lastContactAt(lead: {
  firstCustomerReplyAt: Date | null;
  lastFollowUpAt: Date | null;
}): Date | null {
  const a = lead.firstCustomerReplyAt?.getTime() ?? 0;
  const b = lead.lastFollowUpAt?.getTime() ?? 0;
  const max = Math.max(a, b);
  return max > 0 ? new Date(max) : null;
}

/** 按当前档与距今毫秒计算下一档（只升档不跳档；nurture 后 14d 只提醒不判流失）。 */
function nextSilenceStep(stage: string, elapsedMs: number): SilenceStep | null {
  if (stage === LEAD_SILENCE_STAGE.NONE && elapsedMs >= H24) {
    return { kind: 'advance', silenceStage: LEAD_SILENCE_STAGE.RISK };
  }
  if (stage === LEAD_SILENCE_STAGE.RISK && elapsedMs >= H72) {
    return { kind: 'advance', silenceStage: LEAD_SILENCE_STAGE.FOLLOW_DUE };
  }
  if (stage === LEAD_SILENCE_STAGE.FOLLOW_DUE && elapsedMs >= D7) {
    return {
      kind: 'advance',
      silenceStage: LEAD_SILENCE_STAGE.NURTURE,
      finalStatus: LEAD_FINAL_STATUS.SILENCE,
    };
  }
  if (stage === LEAD_SILENCE_STAGE.NURTURE && elapsedMs >= D14) {
    return { kind: 'remind' };
  }
  return null;
}
