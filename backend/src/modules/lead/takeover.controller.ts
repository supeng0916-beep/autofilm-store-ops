import { Controller, Get } from '@nestjs/common';

import { RequirePermission } from '../auth/require-permission.decorator';
import { TakeoverService } from './takeover.service';

/** 接管队列端点（P4-05）：GET /leads/takeover 返回接管候选列表 */
@Controller('leads')
export class TakeoverController {
  constructor(private readonly takeover: TakeoverService) {}

  @Get('takeover')
  @RequirePermission('m05:view')
  getCandidates() {
    return this.takeover.getCandidates();
  }
}
