import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RoleplayFinishDto, RoleplayStartDto, RoleplayTurnDto } from './dto/agent.dto';
import { RoleplayService } from './roleplay.service';

/** 销售陪练端点（V1.5 批次6a）：登录即可（练功全员开放，无权限点——jwt 全局守卫强制认证）。
 * 三段流：开局（选剧本+画像）→ 回合（员工说→AI 客户答）→ 结束点评。 */
@Controller('agent/roleplay')
export class RoleplayController {
  constructor(private readonly roleplay: RoleplayService) {}

  /** 开局：POST /agent/roleplay/sessions {scenario, persona?} → 会话+客户开场白 */
  @Post('sessions')
  start(@Body() body: RoleplayStartDto, @CurrentUser() actor: JwtPayload) {
    return this.roleplay.start(actor, body);
  }

  /** 回合：POST /agent/roleplay/sessions/:id/turns {message} → AI 客户回应 */
  @Post('sessions/:id/turns')
  turn(@Param('id') id: string, @Body() body: RoleplayTurnDto, @CurrentUser() actor: JwtPayload) {
    return this.roleplay.turn(actor, id, body);
  }

  /** 结束点评：POST /agent/roleplay/sessions/:id/finish {score?} → 教练复盘（幂等） */
  @Post('sessions/:id/finish')
  @HttpCode(HttpStatus.OK)
  finish(
    @Param('id') id: string,
    @Body() body: RoleplayFinishDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.roleplay.finish(actor, id, body);
  }

  /** 经验卡提炼（批次6b 学习闭环）：陪练会话或粘贴聊天记录 → 建议态经验卡待老板审批 */
  @Post('experience/extract')
  extract(
    @Body() body: { sessionId?: string; rawText?: string },
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.roleplay.extract(actor, body);
  }

  /** 自己的会话列表：GET /agent/roleplay/sessions */
  @Get('sessions')
  list(@CurrentUser() actor: JwtPayload) {
    return this.roleplay.list(actor);
  }
}
