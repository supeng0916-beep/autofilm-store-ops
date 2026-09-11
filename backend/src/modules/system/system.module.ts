import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { NotificationModule } from '../notification/notification.module';
import { SystemBackupService } from './system-backup.service';
import { SystemController } from './system.controller';
import { SystemDiagnosticsService } from './system-diagnostics.service';
import { SystemRepository } from './system.repository';
import { SystemService } from './system.service';

@Module({
  imports: [AuthModule, NotificationModule],
  controllers: [SystemController],
  providers: [SystemService, SystemRepository, SystemBackupService, SystemDiagnosticsService],
})
export class SystemModule {}
