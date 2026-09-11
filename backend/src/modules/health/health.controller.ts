import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { getVersionInfo } from '../../common/version-info';
import { Public } from '../auth/public.decorator';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly config: ConfigService) {}

  /** 健康检查（P0-02；2026-08-27 起附版本信息——客户报障先对版本） */
  @Get()
  health(): { status: string; app: string; env: string } & ReturnType<typeof getVersionInfo> {
    return {
      status: 'ok',
      app: 'autofilm-store-ops',
      env: this.config.get<string>('NODE_ENV') ?? 'dev',
      ...getVersionInfo(),
    };
  }
}
