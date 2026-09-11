import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';

import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AgentService } from './agent.service';
import { AgentChatDto, PersonaMapEntryDto } from './dto/agent.dto';
import { MorningBriefService } from './morning-brief.service';
import { PERSONA_DISPLAY } from './persona.types';
import { PersonaService } from './persona.service';
import { extractReplyPrefix } from './reply-stream.util';

/** Agent 对话入口（2026-08-26 销售 Agent V1）：登录即可（无权限点——jwt 全局守卫强制认证，
 * permission.guard 无 @RequirePermission 元数据时放行）；人格按角色在服务端判定。
 * /chat/stream（同日流式迭代）：SSE 三事件——delta（增量回复文本，服务端已剥离 JSON 语法）、
 * done（终稿 reply+suggestions，权威值以此为准）、error（降级/失败统一离线口径）。 */
@Controller('agent')
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly personaSvc: PersonaService,
    private readonly morningBrief: MorningBriefService,
    private readonly prisma: PrismaService,
  ) {}

  /** 经营晨报手动触发（V1.5 批次2）：boss ∪ sys_admin；当天已生成返回既有内容（幂等） */
  @Post('morning-brief/run')
  @HttpCode(HttpStatus.OK)
  async runMorningBrief(@CurrentUser() actor: JwtPayload) {
    return this.morningBrief.runManual(actor);
  }

  /** 当前用户 persona 自查（V1.5）：登录即可——前端抽屉标题用 */
  @Get('persona')
  async persona(@CurrentUser() actor: JwtPayload) {
    const persona = await this.personaSvc.resolve(actor.sub);
    return { persona, displayName: PERSONA_DISPLAY[persona] };
  }

  /** persona 映射全景（V1.5）：boss ∪ sys_admin（服务层硬校验，沿 ai-cost 提额先例）；
   * 含踩空提示（spec §7 老板娘形态）；entries 联查 username 供前端展示 */
  @Get('persona-map')
  async personaMap(@CurrentUser() actor: JwtPayload) {
    await this.personaSvc.assertBossOrAdmin(actor);
    const [map, hints] = await Promise.all([
      this.personaSvc.readMap(),
      this.personaSvc.unmappedMultiRoleHints(),
    ]);
    const ids = Object.keys(map);
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, username: true, displayName: true },
        })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, u]));
    const entries = Object.entries(map).map(([userId, persona]) => ({
      userId,
      persona,
      username: nameOf.get(userId)?.username ?? '(未知用户)',
      displayName: nameOf.get(userId)?.displayName ?? '',
    }));
    return { entries, unmappedMultiRole: hints };
  }

  /** persona 映射单条 set/del（V1.5）：boss ∪ sys_admin；变更审计在服务层 */
  @Put('persona-map')
  async setPersonaEntry(@Body() dto: PersonaMapEntryDto, @CurrentUser() actor: JwtPayload) {
    await this.personaSvc.assertBossOrAdmin(actor);
    await this.personaSvc.setEntry(actor, dto);
    return { ok: true };
  }

  @Post('chat')
  @HttpCode(HttpStatus.CREATED)
  chat(@Body() dto: AgentChatDto, @CurrentUser() actor: JwtPayload) {
    return this.agent.chat(actor, dto);
  }

  @Post('chat/stream')
  async chatStream(
    @Body() dto: AgentChatDto,
    @CurrentUser() actor: JwtPayload,
    @Res() res: Response,
  ): Promise<void> {
    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // 已下发前缀长度：extractReplyPrefix 正常单调递增，模型重写回退时以更长者为准（不回删）
    let sentLen = 0;
    try {
      const final = await this.agent.chat(actor, dto, (cumulative) => {
        const prefix = extractReplyPrefix(cumulative);
        if (prefix.length > sentLen) {
          send('delta', { text: prefix.slice(sentLen) });
          sentLen = prefix.length;
        }
      });
      const out = (final.output ?? {}) as {
        reply?: unknown;
        suggestions?: unknown;
        assets?: unknown;
        reasoning?: unknown;
      };
      if (final.status === 'done' && typeof out.reply === 'string' && out.reply) {
        // 素材富化：模型只给 id，这里解析成真实存在的 {id,title,licensed}（编造 id 自然丢弃）
        const assetIds = Array.isArray(out.assets)
          ? out.assets.filter((a): a is string => typeof a === 'string')
          : [];
        const assetCandidates = assetIds.length
          ? await this.agent.resolveAssetCandidates(assetIds)
          : [];
        send('done', {
          reply: out.reply,
          suggestions: Array.isArray(out.suggestions)
            ? out.suggestions.filter((s): s is string => typeof s === 'string')
            : [],
          ...(assetCandidates.length ? { assets: assetCandidates } : {}),
          // 决策留痕（T2）：reasoning 随 done 透传，前端折叠展示「决策依据」
          ...(typeof out.reasoning === 'string' && out.reasoning.trim()
            ? { reasoning: out.reasoning }
            : {}),
        });
      } else {
        send('error', { message: 'AI 暂时离线，请稍后再试' });
      }
    } catch {
      // 开关/预算等 AppException 发生在流开启后只能转 SSE error（状态码已 200）
      send('error', { message: 'AI 暂时离线，请稍后再试' });
    } finally {
      res.end();
    }
  }
}
