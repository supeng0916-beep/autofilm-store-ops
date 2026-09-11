import { Module } from '@nestjs/common';

import { NotificationModule } from '../notification/notification.module';
import { AftercareRepository } from './aftercare.repository';
import { ReferralController } from './referral.controller';
import { ReferralService } from './referral.service';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';
import { ServiceRequestController } from './service-request.controller';
import { ServiceRequestService } from './service-request.service';
import { VisitController } from './visit.controller';
import { VisitService } from './visit.service';
import { WarrantyController } from './warranty.controller';
import { WarrantyService } from './warranty.service';

/** 售后域模块（M09 批次1）：回访计划 + 售后受理（投诉直通老板通知）+ 质保登记 + 转介绍登记
 * + 客户评价登记（缺口补齐批次 Task 2，append-only）。
 * PrismaModule/AuditModule 为全局模块，无需显式导入；
 * NotificationModule（V2.2a）供受理投诉与后续售后资源的通知接线（导出 NotificationService）；
 * exports VisitService 供 DeliveryModule 交付钩子跨模块注入（Task 5：交付即排 d7/d30 回访）。 */
@Module({
  imports: [NotificationModule],
  controllers: [
    VisitController,
    ServiceRequestController,
    WarrantyController,
    ReferralController,
    ReviewController,
  ],
  providers: [
    VisitService,
    ServiceRequestService,
    WarrantyService,
    ReferralService,
    ReviewService,
    AftercareRepository,
  ],
  exports: [VisitService],
})
export class AftercareModule {}
