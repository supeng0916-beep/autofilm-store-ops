import { Module } from '@nestjs/common';

import { AftercareModule } from '../aftercare/aftercare.module';
import { ApprovalModule } from '../approval/approval.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { NotificationModule } from '../notification/notification.module';
import { AppointmentController } from './appointment.controller';
import { AppointmentRepository } from './appointment.repository';
import { AppointmentService } from './appointment.service';
import { WorkOrderController } from './work-order.controller';
import { WorkOrderRepository } from './work-order.repository';
import { WorkOrderService } from './work-order.service';

/** 交付域模块（P5/M07+M08）：预约与产能、施工质检交付。
 * PrismaModule/AuditModule 为全局模块；ApprovalModule 供排期确认审批（P5-03）；
 * 审批回调经 AppointmentService.onModuleInit 注册到 ApprovalService.registerHandler；
 * KnowledgeModule（导出 KnowledgeService）供案例回流写入知识库草稿（P5-06）；
 * NotificationModule（V2.2a）：排期审批通过后通知预约发起人；
 * AftercareModule（M09 批次1，导出 VisitService）：交付确认自动生成 d7/d30 回访计划（Task 5）。 */
@Module({
  imports: [AftercareModule, ApprovalModule, KnowledgeModule, NotificationModule],
  controllers: [AppointmentController, WorkOrderController],
  providers: [AppointmentService, AppointmentRepository, WorkOrderService, WorkOrderRepository],
})
export class DeliveryModule {}
