import { Module } from '@nestjs/common';

import { AiDispatchModule } from '../ai-dispatch/ai-dispatch.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { aggregators } from './aggregators';
import { MorningBriefService } from './morning-brief.service';
import { PersonaService } from './persona.service';
import { RoleplayController } from './roleplay.controller';
import { RoleplayService } from './roleplay.service';

/** Agent 模块（2026-08-26）：分角色助手对话入口；AI 通道经 AiDispatchModule 复用。
 * V1.5：PersonaService（显式映射>角色兜底）+ 角色聚合器（boss/manager）。
 * 批次2：MorningBriefService（经营晨报——复用 BossAggregator+skill-boss-agent）。 */
@Module({
  imports: [AiDispatchModule, KnowledgeModule],
  controllers: [AgentController, RoleplayController],
  providers: [AgentService, PersonaService, MorningBriefService, RoleplayService, ...aggregators],
  exports: [PersonaService],
})
export class AgentModule {}
