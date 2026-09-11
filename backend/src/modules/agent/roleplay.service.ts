import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { AiDispatchService } from '../ai-dispatch/ai-dispatch.service';
import type { JwtPayload } from '../auth/auth.types';
import { KnowledgeService } from '../knowledge/knowledge.service';

/** 剧本目录（V1.5 批次6a）：覆盖销售主链路五场景——开局/报价异议/比价/砍价/沉默唤醒。
 * persona 由用户选画像参数（车型/预算/性格/难度），AI 据此演客户。 */
export const ROLEPLAY_SCENARIOS = [
  'first_touch',
  'price_objection',
  'compare',
  'bargain',
  'silent_revive',
] as const;
export type RoleplayScenario = (typeof ROLEPLAY_SCENARIOS)[number];

export const SCENARIO_LABELS: Record<RoleplayScenario, string> = {
  first_touch: '首次触达',
  price_objection: '报价异议',
  compare: '同行比价',
  bargain: '砍价拉锯',
  silent_revive: '沉默唤醒',
};

const ROLEPLAY_CHAT_TASK_TYPE = 'sales.roleplay.chat';
const ROLEPLAY_REVIEW_TASK_TYPE = 'sales.roleplay.review';

/** 销售陪练服务（批次6a）：全员共用练功房——AI 演客户、员工练回答、结束出点评。
 * 会话原文落 roleplay_sessions/turns（审计回溯用，不做检索——长期记忆走提炼后的
 * 经验卡，批次6b）；每轮上下文=剧本+画像+全部回合，服务端持有会话状态。 */
@Injectable()
export class RoleplayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: AiDispatchService,
    private readonly knowledge: KnowledgeService,
  ) {}

  /** 开局：建会话 + AI 客户开场白（staff 未发言即让客户先开口） */
  async start(
    actor: JwtPayload,
    input: { scenario: string; persona?: Record<string, unknown> },
  ): Promise<{
    sessionId: string;
    turns: Array<{ role: string; content: string }>;
  }> {
    if (!(ROLEPLAY_SCENARIOS as readonly string[]).includes(input.scenario)) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, '不支持的剧本，请从剧本列表中选择');
    }
    const session = await this.prisma.roleplaySession.create({
      data: {
        userId: actor.sub,
        scenario: input.scenario,
        ...(input.persona
          ? { persona: input.persona as import('@prisma/client').Prisma.InputJsonValue }
          : {}),
      },
    });
    const task = await this.dispatch.submitTaskAutoRetry(
      ROLEPLAY_CHAT_TASK_TYPE,
      {
        mode: 'play',
        scenario: input.scenario,
        persona: input.persona ?? null,
        staffMessage: null,
        history: [],
      },
      { type: 'roleplay', id: session.id },
    );
    const out = (task.status === 'done' ? task.output : null) as { reply?: unknown } | null;
    const reply = typeof out?.reply === 'string' ? out.reply : '';
    if (!reply) {
      throw new AppException(ErrorCode.AI_DISABLED, 'AI 客户暂不可用，请稍后再试');
    }
    const turn = await this.prisma.roleplayTurn.create({
      data: { sessionId: session.id, role: 'customer', content: reply },
    });
    return { sessionId: session.id, turns: [{ role: turn.role, content: turn.content }] };
  }

  /** 回合：员工发言 → AI 客户回应（上下文=剧本+画像+全部回合） */
  async turn(
    actor: JwtPayload,
    sessionId: string,
    input: { message: string },
  ): Promise<{ reply: string; mood?: string; turns: Array<{ role: string; content: string }> }> {
    const session = await this.getOwnSession(actor, sessionId);
    if (session.status !== 'active') {
      throw new AppException(ErrorCode.VALIDATION_FAILED, '练习已结束，请新开一局');
    }
    await this.prisma.roleplayTurn.create({
      data: { sessionId, role: 'staff', content: input.message },
    });
    const history = await this.prisma.roleplayTurn.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      select: { role: true, content: true },
    });
    const task = await this.dispatch.submitTaskAutoRetry(
      ROLEPLAY_CHAT_TASK_TYPE,
      {
        mode: 'play',
        scenario: session.scenario,
        persona: session.persona ?? null,
        staffMessage: input.message,
        history,
      },
      { type: 'roleplay', id: sessionId },
    );
    const out = (task.status === 'done' ? task.output : null) as {
      reply?: unknown;
      mood?: unknown;
    } | null;
    const reply = typeof out?.reply === 'string' ? out.reply : '';
    if (!reply) {
      throw new AppException(ErrorCode.AI_DISABLED, 'AI 客户暂不可用，请稍后再试');
    }
    const turnRow = await this.prisma.roleplayTurn.create({
      data: { sessionId, role: 'customer', content: reply },
    });
    const turns = await this.prisma.roleplayTurn.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      select: { role: true, content: true },
    });
    void turnRow;
    return {
      reply,
      ...(typeof out?.mood === 'string' ? { mood: out.mood } : {}),
      turns,
    };
  }

  /** 结束点评：AI 以教练视角复盘全对话（优点/改进/话术示范），落库并转 finished；
   * score=员工自评 1~5（可空）。重复 finish 幂等返回既有点评。 */
  async finish(
    actor: JwtPayload,
    sessionId: string,
    input: { score?: number },
  ): Promise<{
    summary: string;
    strengths?: string[];
    improvements?: string[];
    demo?: string;
  }> {
    const session = await this.getOwnSession(actor, sessionId);
    if (session.status === 'finished' && session.review) {
      return session.review as {
        summary: string;
        strengths?: string[];
        improvements?: string[];
        demo?: string;
      };
    }
    const history = await this.prisma.roleplayTurn.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      select: { role: true, content: true },
    });
    const task = await this.dispatch.submitTaskAutoRetry(
      ROLEPLAY_REVIEW_TASK_TYPE,
      {
        mode: 'review',
        scenario: session.scenario,
        persona: session.persona ?? null,
        history,
        ...(typeof input.score === 'number' ? { selfScore: input.score } : {}),
      },
      { type: 'roleplay', id: sessionId },
    );
    const out = (task.status === 'done' ? task.output : null) as { summary?: unknown } | null;
    const summary = typeof out?.summary === 'string' ? out.summary : '';
    if (!summary) {
      throw new AppException(ErrorCode.AI_DISABLED, 'AI 点评暂不可用，请稍后再试');
    }
    await this.prisma.roleplaySession.update({
      where: { id: sessionId },
      data: {
        status: 'finished',
        finishedAt: new Date(),
        ...(typeof input.score === 'number' ? { score: input.score } : {}),
        review: out as import('@prisma/client').Prisma.InputJsonValue,
      },
    });
    return out as { summary: string; strengths?: string[]; improvements?: string[]; demo?: string };
  }

  /** 自己的会话列表（新→旧，含回合计数） */
  async list(actor: JwtPayload): Promise<
    Array<{
      id: string;
      userId: string;
      scenario: string;
      status: string;
      score: number | null;
      startedAt: Date;
      finishedAt: Date | null;
      turnCount: number;
    }>
  > {
    const rows = await this.prisma.roleplaySession.findMany({
      where: { userId: actor.sub },
      orderBy: { startedAt: 'desc' },
      take: 50,
      include: { _count: { select: { turns: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      scenario: r.scenario,
      status: r.status,
      score: r.score,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      turnCount: r._count.turns,
    }));
  }

  /** 经验卡提炼（批次6b 学习闭环）：陪练会话或粘贴聊天记录 → AI 提炼 → 建议态草稿
   * （kind=sales_method，createFromChat 强制草稿+来源标记）→ 老板审批生效后被检索注入。
   * 素材只归属本人（他人会话 404）；AI 判素材不足（reject）时如实返回不建卡。 */
  async extract(
    actor: JwtPayload,
    input: { sessionId?: string; rawText?: string },
  ): Promise<{
    rejected: boolean;
    reason?: string;
    item?: { id: string; kind: string; status: string; title: string; source: string | null };
  }> {
    if (!input.sessionId && !input.rawText?.trim()) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, '请提供陪练会话或粘贴聊天记录');
    }
    let scenario: string | null = null;
    let history: Array<{ role: string; content: string }>;
    if (input.sessionId) {
      const session = await this.getOwnSession(actor, input.sessionId);
      scenario = session.scenario;
      history = await this.prisma.roleplayTurn.findMany({
        where: { sessionId: session.id },
        orderBy: { createdAt: 'asc' },
        select: { role: true, content: true },
      });
    } else {
      // 粘贴文本：按行解析「角色：内容」为对话；无法识别角色的行归 customer
      history = (input.rawText ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const m = l.match(/^(销售|销售员|我|staff|店员)\s*[:：]\s*(.+)$/);
          if (m) return { role: 'staff', content: m[2] };
          const c = l.match(/^(客户|客人|对方|customer)\s*[:：]\s*(.+)$/);
          if (c) return { role: 'customer', content: c[2] };
          return { role: 'customer', content: l };
        });
    }
    const task = await this.dispatch.submitTaskAutoRetry(
      'sales.experience.extract',
      {
        source: input.sessionId ? 'roleplay' : 'chatlog',
        ...(scenario ? { scenario } : {}),
        history,
      },
      { type: 'experience', id: input.sessionId ?? actor.sub },
    );
    const out = (task.status === 'done' ? task.output : null) as {
      title?: unknown;
      content?: unknown;
      reject?: unknown;
    } | null;
    if (typeof out?.reject === 'string' && out.reject) {
      return { rejected: true, reason: out.reject };
    }
    if (
      typeof out?.title !== 'string' ||
      !out.title ||
      typeof out.content !== 'string' ||
      !out.content
    ) {
      throw new AppException(ErrorCode.AI_DISABLED, '提炼结果无效，请稍后再试');
    }
    const tags = Array.isArray((out as { tags?: unknown }).tags)
      ? (out as { tags: unknown[] }).tags.filter((x): x is string => typeof x === 'string')
      : [];
    const item = await this.knowledge.createFromChat(actor, {
      kind: 'sales_method',
      title: out.title.slice(0, 80),
      content: `${out.content}${tags.length ? `\n标签：${tags.join('、')}` : ''}`,
      sourceLabel: '销售经验提炼',
    });
    return {
      rejected: false,
      item: {
        id: item.id,
        kind: item.kind,
        status: item.status,
        title: item.title,
        source: item.source,
      },
    };
  }

  /** 会话归属校验：非本人会话按 404 处理（不暴露他人会话存在性） */
  private async getOwnSession(actor: JwtPayload, sessionId: string) {
    const session = await this.prisma.roleplaySession.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== actor.sub) {
      throw new AppException(ErrorCode.NOT_FOUND, '练习会话不存在');
    }
    return session;
  }
}
