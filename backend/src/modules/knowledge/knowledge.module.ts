import { forwardRef, Module } from '@nestjs/common';

import { AiDispatchModule } from '../ai-dispatch/ai-dispatch.module';
import { AuthModule } from '../auth/auth.module';
import { ApprovalModule } from '../approval/approval.module';
import { EmbeddingService } from './embedding.service';
import { KnowledgeAiModule } from './knowledge-ai.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeRepository } from './knowledge.repository';
import { KnowledgeSearchController } from './knowledge-search.controller';
import { KnowledgeSearchService } from './knowledge-search.service';
import { KnowledgeService } from './knowledge.service';
import { RagService } from './rag.service';

/** 知识库模块（P4/M06）：PrismaModule/AuditModule 为全局模块；
 * 导入 AuthModule 供角色判定，forwardRef(ApprovalModule) 供价格审批，
 * AiDispatchModule 供知识检索提交 AI 任务。
 * 审批回调通过 KnowledgeService.onModuleInit 注册到 ApprovalService.registerHandler。
 * P4-02：EmbeddingService + RagService 提供向量化与语义检索。
 * P4-03：KnowledgeAiModule 注册 knowledge.search taskType；KnowledgeSearchService 提供检索逻辑。 */
@Module({
  imports: [AuthModule, forwardRef(() => ApprovalModule), AiDispatchModule, KnowledgeAiModule],
  controllers: [KnowledgeController, KnowledgeSearchController],
  providers: [
    KnowledgeService,
    KnowledgeRepository,
    EmbeddingService,
    RagService,
    KnowledgeSearchService,
  ],
  // P5-06：DeliveryModule 案例回流复用 KnowledgeService 写案例草稿
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
