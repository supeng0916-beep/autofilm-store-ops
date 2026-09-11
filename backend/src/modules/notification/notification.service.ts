import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/** 通知内容载荷：kind 为业务类型标识（approval_pending/appointment_confirmed/…），
 * sourceType/sourceId 指回业务对象（如 approval/<id>），供前端跳转与聚合去重 */
export interface NotifyInput {
  kind: string;
  title: string;
  body?: string;
  link?: string;
  sourceType?: string;
  sourceId?: string;
}

/** 站内通知服务（V2.2a）：按收件人落库，尽力而为——发送失败不影响业务主流程，
 * 故 notify/notifyRoleHolders 捕获异常记日志并返回实际写入数（可能为 0）。 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 批量写入通知，返回成功写入条数 */
  async notify(input: NotifyInput & { userIds: string[] }): Promise<number> {
    const { userIds, ...content } = input;
    if (userIds.length === 0) return 0;
    try {
      const res = await this.prisma.notification.createMany({
        data: userIds.map((userId) => ({ ...content, userId })),
      });
      return res.count;
    } catch (err) {
      this.logger.warn(
        `通知写入失败（kind=${input.kind}，收件人 ${userIds.length} 人）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }
  }

  /** 按角色群发给全部在职持有人，返回成功写入条数。
   * 尽力而为：整段纳入捕获——持有人查询失败同样不得外抛阻塞业务（内部 notify 已自捕获，
   * 此处兜住查询段），失败记日志返回 0。 */
  async notifyRoleHolders(roles: string[], input: NotifyInput): Promise<number> {
    try {
      const holders = await this.prisma.user.findMany({
        where: { disabled: false, userRoles: { some: { role: { code: { in: roles } } } } },
        select: { id: true },
      });
      return await this.notify({ ...input, userIds: holders.map((u) => u.id) });
    } catch (err) {
      this.logger.warn(
        `通知按角色群发失败（roles=${roles.join(',')}，kind=${input.kind}）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }
  }

  /** 本人通知列表：createdAt 倒序取前 50 条（前端通知中心单页口径） */
  listFor(userId: string, opts: { unreadOnly?: boolean } = {}) {
    return this.prisma.notification.findMany({
      where: { userId, ...(opts.unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /** 单条标记已读：updateMany 限定 userId+未读，天然防越权改他人通知且幂等（重复已读返回 0） */
  markRead(userId: string, id: string): Promise<number> {
    return this.prisma.notification
      .updateMany({
        where: { id, userId, readAt: null },
        data: { readAt: new Date() },
      })
      .then((r) => r.count);
  }

  /** 全部标记已读：返回本次标记条数 */
  markAllRead(userId: string): Promise<number> {
    return this.prisma.notification
      .updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } })
      .then((r) => r.count);
  }

  /** 未读数（前端角标） */
  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }
}
