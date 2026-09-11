import { Controller, Get, Param, Post, Query } from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { ListNotificationsQueryDto } from './dto/notification.dto';
import { NotificationService } from './notification.service';

/** 通知中心端点（V2.2a）：全部仅需认证（无 @RequirePermission）——站内信只关乎本人；
 * 收件人一律取 actor.sub，绝不接受 body 传 userId，读写天然限定本人范围防越权。
 * read/read-all 幂等：重复已读返回 updated=0 而非报错。 */
@Controller('notifications')
export class NotificationController {
  constructor(private readonly svc: NotificationService) {}

  @Get()
  list(@Query() query: ListNotificationsQueryDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.listFor(actor.sub, { unreadOnly: query.unread === '1' });
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() actor: JwtPayload) {
    return { count: await this.svc.unreadCount(actor.sub) };
  }

  @Post('read-all')
  async markAllRead(@CurrentUser() actor: JwtPayload) {
    return { updated: await this.svc.markAllRead(actor.sub) };
  }

  @Post(':id/read')
  async markRead(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return { updated: await this.svc.markRead(actor.sub, id) };
  }
}
