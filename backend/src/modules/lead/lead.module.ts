import { forwardRef, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import {
  APPROVAL_DECISION_HANDLER,
  type ApprovalDecisionHandler,
} from '../approval/approval.service';
import { ApprovalModule } from '../approval/approval.module';
import { AiDispatchModule } from '../ai-dispatch/ai-dispatch.module';
import { LeadAiModule } from './ai/lead-ai.module';
import { LeadClassifyController } from './ai/lead-classify.controller';
import { LeadClassifyService } from './ai/lead-classify.service';
import { LeadSummaryService } from './ai/lead-summary.service';
import { SalesDraftController } from './ai/sales-draft.controller';
import { SalesDraftService } from './ai/sales-draft.service';
import { AssignService } from './assign.service';
import { DedupService } from './dedup.service';
import { KingsoftService } from './kingsoft.service';
import { LeadController } from './lead.controller';
import { LeadImportController, LeadMergeController } from './lead-import.controller';
import { LeadImportService } from './lead-import.service';
import { LeadLifecycleService } from './lead-lifecycle.service';
import { LeadManualService } from './lead-manual.service';
import { LeadRepository } from './lead.repository';
import { LeadService } from './lead.service';
import { SilenceService } from './silence.service';
import { SlaService } from './sla.service';
import { TakeoverController } from './takeover.controller';
import { TakeoverService } from './takeover.service';

/** 客资模块（P3）：PrismaModule/AuditModule 为全局模块；AuthModule 供 UsersRepository（角色/范围判定）。
 * forwardRef(ApprovalModule)：发起流失审批需 ApprovalRepository，同时向外提供流失决定回调（双向 forwardRef 解环）。 */
@Module({
  imports: [AuthModule, forwardRef(() => ApprovalModule), LeadAiModule, AiDispatchModule],
  controllers: [
    // 字面量路由必须先于 LeadController 的 @Get(':id') 注册，否则 /leads/takeover
    // 会被参数路由吞掉返回「客资不存在」（2026-08-24 门店实测回归）
    TakeoverController,
    LeadController,
    LeadImportController,
    LeadMergeController,
    SalesDraftController,
    LeadClassifyController,
  ],
  providers: [
    LeadService,
    LeadImportService,
    LeadManualService,
    AssignService,
    KingsoftService,
    LeadRepository,
    DedupService,
    SlaService,
    LeadLifecycleService,
    SilenceService,
    SalesDraftService,
    LeadClassifyService,
    LeadSummaryService,
    TakeoverService,
    {
      provide: APPROVAL_DECISION_HANDLER,
      inject: [LeadLifecycleService],
      useFactory:
        (lifecycle: LeadLifecycleService): ApprovalDecisionHandler =>
        (item) =>
          lifecycle.applyChurnDecision(item.id, item.status === 'approved'),
    },
  ],
  exports: [APPROVAL_DECISION_HANDLER],
})
export class LeadModule {}
