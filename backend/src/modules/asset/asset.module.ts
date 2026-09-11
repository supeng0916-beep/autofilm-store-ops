import { Module } from '@nestjs/common';

import { AiDispatchModule } from '../ai-dispatch/ai-dispatch.module';
import { NotificationModule } from '../notification/notification.module';
import { AssetController } from './asset.controller';
import { AssetService } from './asset.service';

/** 素材库模块（M06，V2.3b）：PrismaModule/AuditModule 为全局模块，ConfigModule 全局——
 * 无需显式导入（S08 repository 省略，service 直调 Prisma 先例）。
 * NotificationModule：v1.5 T12 watch 导入完成后给 boss 发汇总通知。
 * AiDispatchModule：v1.5 T13 asset.suggest_tags 技能登记与提交（A09 待批准发布，仅登记）。 */
@Module({
  imports: [AiDispatchModule, NotificationModule],
  controllers: [AssetController],
  providers: [AssetService],
})
export class AssetModule {}
