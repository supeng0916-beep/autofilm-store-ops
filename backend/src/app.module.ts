import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { AuditModule } from './common/audit';
import { validateEnv } from './common/config/env.schema';
import { AftercareModule } from './modules/aftercare/aftercare.module';
import { AiDispatchModule } from './modules/ai-dispatch/ai-dispatch.module';
import { StoreMcpModule } from './modules/ai-dispatch/store-mcp/store-mcp.module';
import { ApprovalModule } from './modules/approval/approval.module';
import { AgentModule } from './modules/agent/agent.module';
import { AssetModule } from './modules/asset/asset.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { FinanceModule } from './modules/finance/finance.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { LeadModule } from './modules/lead/lead.module';
import { MarketingModule } from './modules/marketing/marketing.module';
import { NotificationModule } from './modules/notification/notification.module';
import { OrderModule } from './modules/order/order.module';
import { SearchModule } from './modules/search/search.module';
import { SystemModule } from './modules/system/system.module';
import { TeamModule } from './modules/team/team.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    // AI 超时扫描与健康轮询的定时驱动（Task 7 新依赖 @nestjs/schedule 的用途说明，S10）
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env', validate: validateEnv }),
    HealthModule,
    PrismaModule,
    AuditModule,
    AuthModule,
    SystemModule,
    ApprovalModule,
    AiDispatchModule,
    // 门店 MCP 端点（M02 Task 1）：给 AI 网关的四工具只读店级脱敏视图（/api/v1/mcp）
    StoreMcpModule,
    AgentModule,
    LeadModule,
    KnowledgeModule,
    DeliveryModule,
    // 财务收支流水（批次2 任务2）：M10 append-only 登记，只增不改
    FinanceModule,
    AftercareModule,
    AnalyticsModule,
    MarketingModule,
    NotificationModule,
    // 订单确认单（批次1 Task 7）：M03 客资成交链可选步骤，不作施工单闸门
    OrderModule,
    SearchModule,
    AssetModule,
    TeamModule,
  ],
})
export class AppModule {}
