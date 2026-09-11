import { Module } from '@nestjs/common';

import { FinanceController } from './finance.controller';
import { FinanceRepository } from './finance.repository';
import { FinanceService } from './finance.service';

/** 财务域模块（批次2 任务2，M10）：收支流水 append-only 登记——只增不改，审计留痕。
 * PrismaModule/AuditModule 为全局模块，无需显式导入。 */
@Module({
  controllers: [FinanceController],
  providers: [FinanceService, FinanceRepository],
})
export class FinanceModule {}
