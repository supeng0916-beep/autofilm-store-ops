import { forwardRef, Module } from '@nestjs/common';

import { LeadModule } from '../lead/lead.module';
import { NotificationModule } from '../notification/notification.module';
import { ApprovalController } from './approval.controller';
import { ApprovalRepository } from './approval.repository';
import { ApprovalService } from './approval.service';

/** 审批队列框架（P1-05）：PrismaModule/AuditModule 为全局模块，无需重复导入。
 * forwardRef(LeadModule)：审批决定成功后回调 LeadModule 注册的 APPROVAL_DECISION_HANDLER（lead.churn）；
 * 同时导出 ApprovalRepository/ApprovalService 供 LeadModule 发起流失审批（双向依赖经 forwardRef 解环）。
 * NotificationModule（V2.2a）：创建后通知审批人（boss+store_manager）、决定后通知发起人。 */
@Module({
  imports: [forwardRef(() => LeadModule), NotificationModule],
  controllers: [ApprovalController],
  providers: [ApprovalService, ApprovalRepository],
  exports: [ApprovalService, ApprovalRepository],
})
export class ApprovalModule {}
