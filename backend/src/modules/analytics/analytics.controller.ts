import { Controller, Get, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { AnalyticsService } from './analytics.service';
import { DashboardService } from './dashboard.service';

/** 经营复盘查询（GET /analytics/overview?from=&to=）——缺省近 30 天 */
export class AnalyticsQueryDto extends createZodDto(
  z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }),
) {}

/** 经营复盘端点（M10 最小版）：老板/店长全局，销售本人范围（服务层过滤），记录员无权限 */
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly svc: AnalyticsService,
    private readonly dashboard: DashboardService,
  ) {}

  /** 控制面板聚合（V2.0 首页）：全部业务角色可见（记录员经 m08:view 命中） */
  @Get('dashboard')
  @RequirePermission('m03:view', 'm08:view')
  getDashboard(@CurrentUser() actor: JwtPayload) {
    return this.dashboard.overview(actor);
  }

  @Get('overview')
  @RequirePermission('m10:view')
  overview(@Query() query: AnalyticsQueryDto, @CurrentUser() actor: JwtPayload) {
    const range = {
      from: query.from ? new Date(query.from) : defaultFrom(),
      to: query.to ? new Date(query.to) : new Date(),
    };
    this.svc.assertRange(range.from, range.to);
    return this.svc.overview(actor, range);
  }
}

/** 缺省时间窗：近 30 天（门店月度复盘口径） */
function defaultFrom(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d;
}
