import { http } from './http';

/** 站内通知（V2.2a）：kind 为业务类型标识（approval_pending/approval_decided/appointment_confirmed/…）；
 * readAt=null 即未读，link 供点击跳转 */
export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  readAt: string | null;
  createdAt: string;
}

/** 通知中心 api（V2.2a Task5）：全部端点仅需认证，收发天然限定本人 */
export const notificationApi = {
  /** 本人通知列表（createdAt 倒序，最多 50 条）；unreadOnly 只取未读 */
  list(unreadOnly = false): Promise<AppNotification[]> {
    return http
      .get<AppNotification[]>('/notifications', { params: unreadOnly ? { unread: 1 } : {} })
      .then((r) => r.data);
  },

  /** 未读数（铃铛角标） */
  unreadCount(): Promise<number> {
    return http.get<{ count: number }>('/notifications/unread-count').then((r) => r.data.count);
  },

  /** 单条标记已读（幂等）：返回实际更新条数（0=已读或非本人） */
  markRead(id: string): Promise<number> {
    return http.post<{ updated: number }>(`/notifications/${id}/read`).then((r) => r.data.updated);
  },

  /** 全部标记已读：返回本次标记条数 */
  markAllRead(): Promise<number> {
    return http.post<{ updated: number }>('/notifications/read-all').then((r) => r.data.updated);
  },
};
