import { Module } from '@nestjs/common';

import { AgentModule } from '../agent/agent.module';
import { AiDispatchModule } from '../ai-dispatch/ai-dispatch.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ContentRecordController } from './content-record.controller';
import { ContentRecordRepository } from './content-record.repository';
import { ContentRecordService } from './content-record.service';
import { MarketingAiModule } from './marketing-ai.module';
import { MarketingController } from './marketing.controller';
import { CompetitorDailyService } from './competitor-daily.service';
import { CompetitorPostController } from './competitor-post.controller';
import { CompetitorPostService } from './competitor-post.service';
import { IndustryDailyService } from './industry-daily.service';
import { InspirationScanScheduler } from './inspiration-scan-scheduler.service';
import { MarketingService } from './marketing.service';
import { VideoInspirationController } from './video-inspiration.controller';
import { VideoInspirationService } from './video-inspiration.service';

/** 经营任务中心（V2.1 首批，M02）：短视频文案 + 同行信息整理。
 * AiDispatchModule（经 MarketingAiModule）供 AI 任务提交；KnowledgeModule 导出
 * KnowledgeService 供同行整理写知识草稿（人工审核生效）。
 * 内容台账（批次2 任务3）：登记已发布内容——归因键与互动数据，供复盘归因；
 * 灵感库（批次B Task 1）：爆款参考数据沉淀，供文案生成注入参考；
 * T4 灵感自动扫描：InspirationScanScheduler 每日定时扫爆款分析落 candidate 候选；
 * PrismaModule/AuditModule 为全局模块，无需显式导入。 */
@Module({
  imports: [AgentModule, AiDispatchModule, MarketingAiModule, KnowledgeModule],
  controllers: [
    MarketingController,
    ContentRecordController,
    CompetitorPostController,
    VideoInspirationController,
  ],
  providers: [
    MarketingService,
    CompetitorDailyService,
    IndustryDailyService,
    InspirationScanScheduler,
    ContentRecordService,
    ContentRecordRepository,
    CompetitorPostService,
    VideoInspirationService,
  ],
})
export class MarketingModule {}
