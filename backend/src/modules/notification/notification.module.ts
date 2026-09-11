import { Module } from '@nestjs/common';

import { HeartbeatService } from './heartbeat.service';

import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

/** 通知中心模块（V2.2a）：PrismaModule 为全局模块无需导入；
 * 导出 NotificationService 供审批/预约等业务在关键节点发站内通知 */
@Module({
  controllers: [NotificationController],
  providers: [HeartbeatService, NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
