import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { NotificationService } from '../src/modules/notification/notification.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

/** 通知中心集成测试（V2.2a）：服务直调 + 本人通知 REST 端点 */
describe('通知中心（V2.2a）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let svc: NotificationService;
  const password = 'S3cure-Passw0rd!';
  let userId = '';
  let userBId = '';
  let token = '';

  /** 建号（可选拿角色）并登录取 token */
  const mkUser = async (roleCode?: string): Promise<{ token: string; id: string }> => {
    const uname = uniqueUsername('ntf');
    const u = await prisma.user.create({
      data: {
        username: uname,
        passwordHash: await auth.hashPassword(password),
        displayName: uname,
      },
    });
    if (roleCode) {
      const role = await prisma.role.upsert({
        where: { code: roleCode },
        update: {},
        create: { code: roleCode, name: roleCode },
      });
      await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
    }
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username: uname, password });
    expect(res.status).toBe(201);
    return { token: (res.body as { accessToken: string }).accessToken, id: u.id };
  };

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    svc = app.get(NotificationService);
    const a = await mkUser('boss');
    userId = a.id;
    token = a.token;
    const b = await mkUser();
    userBId = b.id;
  });
  afterAll(async () => {
    // 只清本 spec 维度：A/B 两人通知 + boss 群发残留（测试库有历史数据，禁全库计数）
    await prisma.notification.deleteMany({ where: { userId: { in: [userId, userBId] } } });
    await prisma.notification.deleteMany({ where: { kind: 'test', title: '群发' } });
    await app.close();
  });

  it('notify→未读数→已读（单条/全部）', async () => {
    const n = await svc.notify({
      userIds: [userId],
      kind: 'approval_pending',
      title: '新审批：排期确认',
      link: '/approvals',
    });
    expect(n).toBe(1);
    expect(await svc.unreadCount(userId)).toBe(1);
    const list = await svc.listFor(userId, {});
    expect(list[0]?.title).toBe('新审批：排期确认');
    const id = list[0].id;
    expect(await svc.markRead(userId, id)).toBe(1);
    expect(await svc.markRead(userId, id)).toBe(0); // 重复已读幂等
    await svc.notify({ userIds: [userId], kind: 'test', title: 'b' });
    await svc.markAllRead(userId);
    expect(await svc.unreadCount(userId)).toBe(0);
  });

  it('notifyRoleHolders：按角色群发（boss）', async () => {
    const n = await svc.notifyRoleHolders(['boss'], { kind: 'test', title: '群发' });
    expect(n).toBeGreaterThanOrEqual(1);
  });

  describe('REST 端点', () => {
    it('未认证 401', async () => {
      const res = await request(app.getHttpServer() as Server).get('/api/v1/notifications');
      expect(res.status).toBe(401);
    });

    it('GET /notifications 返回本人列表，A 读不到 B 的通知', async () => {
      await svc.notify({ userIds: [userId], kind: 'test', title: 'A 的通知' });
      await svc.notify({ userIds: [userBId], kind: 'test', title: 'B 的通知' });
      const aNtf = await prisma.notification.findFirstOrThrow({
        where: { userId, title: 'A 的通知' },
      });
      const bNtf = await prisma.notification.findFirstOrThrow({
        where: { userId: userBId, title: 'B 的通知' },
      });

      const res = await request(app.getHttpServer() as Server)
        .get('/api/v1/notifications')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      const rows = res.body as { id: string; userId: string }[];
      expect(rows.some((r) => r.id === aNtf.id)).toBe(true);
      expect(rows.some((r) => r.id === bNtf.id)).toBe(false); // B 的不出现
      expect(rows.every((r) => r.userId === userId)).toBe(true);
    });

    it('GET /notifications?unread=1 只取未读', async () => {
      await svc.notify({ userIds: [userId], kind: 'test', title: '未读过滤用' });
      const ntf = await prisma.notification.findFirstOrThrow({
        where: { userId, title: '未读过滤用' },
      });

      // 未读时应在列
      let res = await request(app.getHttpServer() as Server)
        .get('/api/v1/notifications?unread=1')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect((res.body as { id: string }[]).some((r) => r.id === ntf.id)).toBe(true);

      // 标记已读后不应在列
      await request(app.getHttpServer() as Server)
        .post(`/api/v1/notifications/${ntf.id}/read`)
        .set('Authorization', `Bearer ${token}`);
      res = await request(app.getHttpServer() as Server)
        .get('/api/v1/notifications?unread=1')
        .set('Authorization', `Bearer ${token}`);
      expect((res.body as { id: string }[]).some((r) => r.id === ntf.id)).toBe(false);
    });

    it('POST /notifications/:id/read 已读幂等（重复读返回 0）', async () => {
      await svc.notify({ userIds: [userId], kind: 'test', title: '幂等用' });
      const ntf = await prisma.notification.findFirstOrThrow({
        where: { userId, title: '幂等用' },
      });

      const first = await request(app.getHttpServer() as Server)
        .post(`/api/v1/notifications/${ntf.id}/read`)
        .set('Authorization', `Bearer ${token}`);
      expect(first.status).toBe(201);
      expect((first.body as { updated: number }).updated).toBe(1);

      const again = await request(app.getHttpServer() as Server)
        .post(`/api/v1/notifications/${ntf.id}/read`)
        .set('Authorization', `Bearer ${token}`);
      expect(again.status).toBe(201);
      expect((again.body as { updated: number }).updated).toBe(0);
    });

    it('A 不能标记 B 的通知已读（body 传 userId 也不生效）', async () => {
      await svc.notify({ userIds: [userBId], kind: 'test', title: '越权用' });
      const bNtf = await prisma.notification.findFirstOrThrow({
        where: { userId: userBId, title: '越权用' },
      });

      // 携带伪造 userId 的 body：端点不读 body，B 的通知保持未读
      const res = await request(app.getHttpServer() as Server)
        .post(`/api/v1/notifications/${bNtf.id}/read`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userId });
      expect(res.status).toBe(201);
      expect((res.body as { updated: number }).updated).toBe(0);
      const after = await prisma.notification.findUniqueOrThrow({ where: { id: bNtf.id } });
      expect(after.readAt).toBeNull();
    });

    it('GET unread-count → read-all → 0', async () => {
      await svc.notify({ userIds: [userId], kind: 'test', title: 'read-all 用' });
      const srv = app.getHttpServer() as Server;
      let res = await request(srv)
        .get('/api/v1/notifications/unread-count')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect((res.body as { count: number }).count).toBeGreaterThanOrEqual(1);

      const all = await request(srv)
        .post('/api/v1/notifications/read-all')
        .set('Authorization', `Bearer ${token}`);
      expect(all.status).toBe(201);
      expect((all.body as { updated: number }).updated).toBeGreaterThanOrEqual(1);

      res = await request(srv)
        .get('/api/v1/notifications/unread-count')
        .set('Authorization', `Bearer ${token}`);
      expect((res.body as { count: number }).count).toBe(0);
    });
  });
});
