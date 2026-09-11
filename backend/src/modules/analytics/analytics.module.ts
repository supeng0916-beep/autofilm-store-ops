import { Module } from '@nestjs/common';

import { AnalyticsController } from './analytics.controller';
import { AnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';
import { DashboardService } from './dashboard.service';

/** 经营复盘模块（M10 最小版，2026-08-18）：leads/work_orders 确定性聚合，无新表 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsRepository, DashboardService],
})
export class AnalyticsModule {}
