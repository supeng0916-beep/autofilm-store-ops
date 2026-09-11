import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { AiCostService } from './ai-cost.service';
import { SkillVersionService } from './skill-version.service';
import { AiUsageService } from './ai-usage.service';
import { ShadowHarvestService } from './shadow-harvest.service';
import { AiDispatchService } from './ai-dispatch.service';

class HelloTaskDto extends createZodDto(
  z.object({ name: z.string().min(1).max(50).default('AutoFilm Demo') }),
) {}

class DailyCostQueryDto extends createZodDto(
  z.object({ days: z.coerce.number().int().min(1).max(30).default(7) }),
) {}

/** 临时提额入参（v1.5 注意事项 6）：单位分，上下界防误输（下限 1 元，上限 10 万元） */
class SetDailyBudgetDto extends createZodDto(
  z.object({ budgetFen: z.coerce.number().int().min(100).max(10_000_000) }),
) {}

/** 影子样本转卡入参（阶段三 B2）：scope 二选一——draft 按 taskId（话术对比/照发候选），
 * intent 按 leadId+双判级（意向改判样本）；条件必填走 superRefine（同预约 DTO 先例），
 * 服务层确定性拼卡，无 AI 调用。 */
class ShadowExperienceDto extends createZodDto(
  z
    .object({
      scope: z.enum(['draft', 'intent']),
      taskId: z.string().min(1).max(64).optional(),
      leadId: z.string().min(1).max(64).optional(),
      aiLevel: z.string().min(1).max(32).optional(),
      humanLevel: z.string().min(1).max(32).optional(),
      reason: z.string().max(500).optional(),
    })
    .superRefine((v, ctx) => {
      if (v.scope === 'draft' && !v.taskId) {
        ctx.addIssue({ code: 'custom', message: '话术样本转卡需提供 taskId', path: ['taskId'] });
      }
      if (v.scope === 'intent' && (!v.leadId || !v.aiLevel || !v.humanLevel)) {
        ctx.addIssue({
          code: 'custom',
          message: '意向样本转卡需提供 leadId/aiLevel/humanLevel',
          path: ['leadId'],
        });
      }
    }),
) {}

/** AI 通道端点（D-P2-10）：P2 阶段仅 hello 自测入口 + 成本日报（Task 8）。
 * §5.3 业务 skill 入口随 P3/P4 模块落地；开关与预算门禁在 submitTask 内统一生效。 */
@Controller('ai')
export class AiController {
  constructor(
    private readonly dispatch: AiDispatchService,
    private readonly costs: AiCostService,
    private readonly usage: AiUsageService,
    private readonly skillVersions_: SkillVersionService,
    private readonly harvester: ShadowHarvestService,
  ) {}

  @Post('tasks/hello')
  hello(@Body() body: HelloTaskDto) {
    return this.dispatch.submitTask('hello', { name: body.name });
  }

  /** 成本日报（D-P2-6 观察口径）：近 N 天任务数/token/成本，ai:cost:view 专属（boss+sys_admin） */
  @Get('costs/daily')
  @RequirePermission('ai:cost:view')
  daily(@Query() query: DailyCostQueryDto) {
    return this.costs.dailySummary(query.days);
  }

  /** 成本三维分解（v1.5 注意事项 6）：近 N 天 日期×模型×任务类型 聚合，ai:cost:view 专属（同日报口径） */
  @Get('costs/breakdown')
  @RequirePermission('ai:cost:view')
  breakdown(@Query() query: DailyCostQueryDto) {
    return this.costs.breakdown(query.days);
  }

  /** 当日预算横幅（v1.5 注意事项 6）：已耗/有效预算/梯度线，ai:cost:view 专属（同日报口径） */
  @Get('costs/status')
  @RequirePermission('ai:cost:view')
  budgetStatus() {
    return this.costs.budgetStatus();
  }

  /** 使用画像（V1.5 批次3）：人+AI 协作三维聚合（按人/按技能/按日），ai:cost:view 专属（同成本口径） */
  @Get('usage/summary')
  @RequirePermission('ai:cost:view')
  usageSummary(@Query() query: DailyCostQueryDto) {
    return this.usage.summary(query.days);
  }

  /** 影子模式·话术对比（2026-09-03 场景二）：AI 草稿 vs 人工实发（事件源，销售零新增操作） */
  @Get('shadow/draft')
  @RequirePermission('ai:cost:view')
  shadowDraft(@Query() query: DailyCostQueryDto) {
    return this.usage.draftShadow(query.days);
  }

  /** 影子模式·意向对比（批次5）：AI 判级 vs 人工终判一致率，ai:cost:view（经营观察口径） */
  @Get('shadow/intent')
  @RequirePermission('ai:cost:view')
  shadowIntent(@Query() query: DailyCostQueryDto) {
    return this.usage.intentShadow(query.days);
  }

  /** 影子样本一键转经验卡（阶段三 B2）：确定性拼卡走 createFromChat 落建议态草稿，
   * 零 AI 成本；门禁与影子面板同口径（ai:cost:view，boss∪sys_admin 经营观察）。 */
  @Post('shadow/experience')
  @RequirePermission('ai:cost:view')
  shadowExperience(@Body() body: ShadowExperienceDto, @CurrentUser() actor: JwtPayload) {
    return body.scope === 'draft'
      ? this.harvester.harvestDraft(actor, { taskId: body.taskId ?? '' })
      : this.harvester.harvestIntent(actor, {
          leadId: body.leadId ?? '',
          aiLevel: body.aiLevel ?? '',
          humanLevel: body.humanLevel ?? '',
          reason: body.reason,
        });
  }

  /** 技能版本视图（批次5）：注册表当前版本+可回滚快照；boss∪sys_admin（服务层硬校验） */
  @Get('skills/versions')
  skillVersions(@CurrentUser() actor: JwtPayload) {
    return this.skillVersions_.versions(actor);
  }

  /** 技能一键回滚（批次5）：快照覆盖技能文件（网关热加载即时生效）+注册表版本同步+审计 */
  @Post('skills/rollback')
  @HttpCode(HttpStatus.OK)
  rollbackSkill(
    @Body() body: { skillName: string; version: number },
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.skillVersions_.rollback(actor, body);
  }

  /** 老板临时提额（v1.5 注意事项 6）：仅当日有效，次日自动回落；boss 硬校验在服务层。
   * 200 而非 201：语义为「调整既有预算键」而非新建资源（测试断言 200）。 */
  @Post('costs/daily-budget')
  @HttpCode(HttpStatus.OK)
  setDailyBudget(@Body() body: SetDailyBudgetDto, @CurrentUser() actor: JwtPayload) {
    return this.costs.setDailyOverride(actor.sub, actor.username, body.budgetFen);
  }
}
