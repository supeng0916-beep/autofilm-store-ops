import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NotificationModule } from '../notification/notification.module';
import { AiCallbackController } from './ai-callback.controller';
import { McpGovernorModule } from './mcp-governor/mcp-governor.module';
import { AiCallbackService } from './ai-callback.service';
import { AiController } from './ai.controller';
import { AiCostService } from './ai-cost.service';
import { AiUsageService } from './ai-usage.service';
import { ShadowHarvestService } from './shadow-harvest.service';
import { SkillVersionService } from './skill-version.service';
import { AiDispatchService } from './ai-dispatch.service';
import { AiTaskRegistry } from './ai-dispatch.registry';
import { AiHealthService } from './ai-health.service';
import { AiStatusController } from './ai-status.controller';
import { AiSwitchService } from './ai-switch.service';
import { AiTaskRepository } from './ai-task.repository';
import { AiTasksController } from './ai-tasks.controller';
import { CustomerRefService } from './customer-ref.service';
import { OPENCLAW_GATEWAY } from './gateway.interface';
import { WsOpenClawGateway } from './ws-openclaw.gateway';

/** 依赖方向（Task 7 检查更新，P3-00）：AiDispatchService → AiCallbackService（forwardRef，仅 applyEnvelope）
 * 与 AiCallbackService → AiDispatchService（transition）构成一对服务环，用 forwardRef 破环；
 * 其余方向单一（健康→调度→开关），无环。
 * NotificationModule（V2.2b）：降级/失败落定通知 boss+sys_admin，复用 V2.2a 通知服务。
 * 影子样本回流（阶段三 B2）：ShadowHarvestService 经 ModuleRef 取 KnowledgeService
 * 复用 createFromChat 落经验卡草稿——KnowledgeModule 已 import 本模块（知识检索提交
 * AI 任务），模块级互相 import 在 vitest SSR 转换下不稳，故不走 imports 破环。 */
@Module({
  // McpGovernorModule（F07/F11）：叶子模块，StoreMcpModule 同样依赖，方向恒为 两侧→叶子，无环
  imports: [NotificationModule, McpGovernorModule],
  controllers: [AiCallbackController, AiController, AiStatusController, AiTasksController],
  providers: [
    AiDispatchService,
    AiCallbackService,
    AiTaskRegistry,
    AiTaskRepository,
    AiSwitchService,
    AiHealthService,
    AiCostService,
    AiUsageService,
    ShadowHarvestService,
    SkillVersionService,
    CustomerRefService,
    {
      provide: OPENCLAW_GATEWAY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new WsOpenClawGateway({
          // 缺省 ''：未配置时构造「未配置」实例，submit 抛通道未配置错、health() false（D-P3-1）
          url: config.get<string>('WG_OPENCLAW_GATEWAY_WS_URL') ?? '',
          token: config.get<string>('WG_OPENCLAW_GATEWAY_TOKEN') ?? '',
          deadlineMs: config.get<number>('WG_AI_DISPATCH_DEADLINE_S', 300) * 1000,
        }),
    },
  ],
  exports: [
    AiDispatchService,
    AiTaskRegistry,
    AiTaskRepository,
    AiSwitchService,
    AiHealthService,
    AiCostService,
    AiUsageService,
    SkillVersionService,
    CustomerRefService,
  ],
})
export class AiDispatchModule {}
