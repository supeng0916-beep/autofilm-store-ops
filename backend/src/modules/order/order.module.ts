import { Module } from '@nestjs/common';

import { OrderConfirmationController } from './order-confirmation.controller';
import { OrderConfirmationRepository } from './order-confirmation.repository';
import { OrderConfirmationService } from './order-confirmation.service';

/** 订单域模块（批次1 Task 7，M03 客资成交链）：订单确认单——报价快照与定金尾款记录。
 * PrismaModule/AuditModule 为全局模块，无需显式导入。
 * 定位：可选步骤，不对施工单/预约加闸门（老板已拍板 2026-09-01），故不依赖 DeliveryModule。 */
@Module({
  controllers: [OrderConfirmationController],
  providers: [OrderConfirmationService, OrderConfirmationRepository],
})
export class OrderModule {}
