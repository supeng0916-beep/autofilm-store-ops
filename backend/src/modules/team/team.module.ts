import { RewardRuleController } from './reward-rule.controller';
import { RewardRuleService } from './reward-rule.service';
import { Module } from '@nestjs/common';

import { AiDispatchModule } from '../ai-dispatch/ai-dispatch.module';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';

/** 人机团队模块（M08，V2.4）：聚合技师档案（technicians）+ 施工指标（work_orders）+
 * Agent 花名册（AiTaskRegistry 已由 AiDispatchModule 导出——花名册代码事实来源）。
 * PrismaModule 为全局模块无需显式导入（S08 先例，service 直调 PrismaService）。 */
@Module({
  imports: [AiDispatchModule],
  controllers: [RewardRuleController, TeamController],
  providers: [RewardRuleService, TeamService],
})
export class TeamModule {}
