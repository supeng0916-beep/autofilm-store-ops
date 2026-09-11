import { Body, Controller, Get, Put } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { AiHealthService } from './ai-health.service';
import { AiSwitchService } from './ai-switch.service';

class SetSwitchDto extends createZodDto(
  z
    .object({
      scope: z.enum(['global', 'skill']),
      taskType: z.string().min(1).optional(),
      enabled: z.boolean(),
      confirmed: z.literal(true), // 与审批同款二次确认
    })
    // scope=skill 时 taskType 必填（P2 终审 triage）：由 DTO 显式校验取代控制器 taskType! 非空断言
    .superRefine((val, ctx) => {
      if (val.scope === 'skill' && !val.taskType) {
        ctx.addIssue({
          code: 'custom',
          path: ['taskType'],
          message: 'scope=skill 时 taskType 必填',
        });
      }
    }),
) {}

/** AI 通道状态端点：status 对全体登录用户开放（降级提示需要人人可见）；
 * switches 读写仅 system:manage（矩阵「系统配置」行，P2 不新增权限点）。 */
@Controller('ai')
export class AiStatusController {
  constructor(
    private readonly switches: AiSwitchService,
    private readonly health: AiHealthService,
  ) {}

  @Get('status')
  async status() {
    const [sw, hp] = await Promise.all([this.switches.snapshot(), this.health.checkNow()]);
    return {
      globalEnabled: sw.global,
      healthy: hp.healthy,
      lastHealthyAt: hp.lastHealthyAt,
      lastError: hp.lastError,
      skills: sw.skills,
      notice: sw.global && hp.healthy ? null : 'AI 暂不可用，请人工处理',
    };
  }

  @Get('switches')
  @RequirePermission('system:manage')
  switchesSnapshot() {
    return this.switches.snapshot();
  }

  @Put('switches')
  @RequirePermission('system:manage')
  async setSwitch(@CurrentUser() actor: JwtPayload, @Body() body: SetSwitchDto) {
    const target =
      body.scope === 'global'
        ? { scope: 'global' as const }
        : // superRefine 已保证 scope=skill 时 taskType 非空，此处不再依赖非空断言
          { scope: 'skill' as const, taskType: body.taskType ?? '' };
    await this.switches.setSwitch(actor, target, body.enabled);
    return this.switches.snapshot();
  }
}
