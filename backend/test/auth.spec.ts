import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface AuthBody {
  accessToken: string;
  refreshToken: string;
  user: { id: string; username: string; displayName: string };
}
interface ErrorBody {
  code: string;
  message: string;
}

describe('认证系统（P1-01）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const uname = uniqueUsername('alice');
  const bob = uniqueUsername('bob');
  const password = 'S3cure-Passw0rd!';

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    await prisma.user.create({
      data: {
        username: uname,
        passwordHash: await auth.hashPassword(password),
        displayName: '爱丽丝',
      },
    });
    await prisma.user.create({
      data: {
        username: bob,
        passwordHash: await auth.hashPassword(password),
        displayName: '鲍勃',
        disabled: true,
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('正确凭证登录成功，返回双 token 与用户信息', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username: uname, password });
    expect(res.status).toBe(201);
    const body = res.body as AuthBody;
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.user.username).toBe(uname);
  });

  it('错误密码与不存在用户返回同一错误码（不泄露存在性）', async () => {
    const a = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username: uname, password: 'wrong' });
    const b = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username: uniqueUsername('ghost'), password: 'wrong' });
    expect(a.status).toBe(401);
    expect((a.body as ErrorBody).code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(b.status).toBe(401);
    expect((b.body as ErrorBody).code).toBe('AUTH_INVALID_CREDENTIALS');
    expect((a.body as ErrorBody).message).toBe((b.body as ErrorBody).message);
  });

  it('停用账号无法登录', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username: bob, password });
    expect(res.status).toBe(403);
    expect((res.body as ErrorBody).code).toBe('AUTH_ACCOUNT_DISABLED');
  });

  it('连续 5 次失败后锁定，锁定期间正确密码也被拒', async () => {
    const name = uniqueUsername('carol');
    await prisma.user.create({
      data: {
        username: name,
        passwordHash: await auth.hashPassword(password),
        displayName: '卡罗尔',
      },
    });
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username: name, password: 'wrong' });
    }
    const locked = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username: name, password });
    expect(locked.status).toBe(403);
    expect((locked.body as ErrorBody).code).toBe('AUTH_ACCOUNT_LOCKED');
  });

  it('refresh 换新 token；access token 可访问 /auth/me', async () => {
    const login = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username: uname, password });
    const { accessToken, refreshToken } = login.body as AuthBody;

    const me = await request(app.getHttpServer() as Server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(me.status).toBe(200);
    expect((me.body as { user: { username: string }; roles: string[] }).user.username).toBe(uname);

    const refreshed = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });
    expect(refreshed.status).toBe(201);
    expect((refreshed.body as AuthBody).accessToken).toBeTruthy();
  });

  it('无 token 访问受保护端点返回 UNAUTHORIZED；登录写审计', async () => {
    const res = await request(app.getHttpServer() as Server).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect((res.body as ErrorBody).code).toBe('UNAUTHORIZED');

    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'user', action: 'auth.login.success' },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    expect(audits.some((a) => a.objectId && a.actorName === uname)).toBe(true);
  });

  it('停用账号的未过期令牌访问 /auth/me 返回 AUTH_ACCOUNT_DISABLED', async () => {
    const name = uniqueUsername('dave');
    await prisma.user.create({
      data: {
        username: name,
        passwordHash: await auth.hashPassword(password),
        displayName: '戴夫',
      },
    });
    const login = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username: name, password });
    const { accessToken } = login.body as AuthBody;
    await prisma.user.update({ where: { username: name }, data: { disabled: true } });

    const me = await request(app.getHttpServer() as Server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(me.status).toBe(403);
    expect((me.body as ErrorBody).code).toBe('AUTH_ACCOUNT_DISABLED');
  });

  it('锁定账号的 refresh 被拒（AUTH_ACCOUNT_LOCKED，锁定=禁止再认证含续期）', async () => {
    const name = uniqueUsername('erin');
    await prisma.user.create({
      data: {
        username: name,
        passwordHash: await auth.hashPassword(password),
        displayName: '艾琳',
      },
    });
    const login = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username: name, password });
    const { refreshToken } = login.body as AuthBody;
    await prisma.user.update({
      where: { username: name },
      data: { lockedUntil: new Date(Date.now() + 15 * 60_000) },
    });

    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });
    expect(res.status).toBe(403);
    expect((res.body as ErrorBody).code).toBe('AUTH_ACCOUNT_LOCKED');
  });

  it('过期令牌返回 AUTH_TOKEN_EXPIRED（按错误名判定，不依赖文案）', async () => {
    const jwtService = app.get(JwtService);
    const expired = jwtService.sign(
      { sub: 'u-expired', username: 'expired_user', type: 'access' },
      { expiresIn: -10 },
    );
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect((res.body as ErrorBody).code).toBe('AUTH_TOKEN_EXPIRED');
  });

  describe('自行改密（任务书 #11）', () => {
    it('成功：验旧密后更新哈希，可用新密重新登录并写审计 auth.password_changed', async () => {
      const name = uniqueUsername('frank');
      await prisma.user.create({
        data: {
          username: name,
          passwordHash: await auth.hashPassword('Old-Pass123'),
          displayName: '弗兰克',
        },
      });
      const login = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username: name, password: 'Old-Pass123' });
      const { accessToken } = login.body as AuthBody;

      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ oldPassword: 'Old-Pass123', newPassword: 'New-Pass456' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true });

      // 旧密登录被拒、新密登录成功
      const oldLogin = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username: name, password: 'Old-Pass123' });
      expect(oldLogin.status).toBe(401);
      const newLogin = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username: name, password: 'New-Pass456' });
      expect(newLogin.status).toBe(201);

      const audits = await prisma.auditLog.findMany({
        where: { objectType: 'user', action: 'auth.password_changed', actorName: name },
      });
      expect(audits.length).toBe(1);
    });

    it('旧密错误：返回 AUTH_INVALID_CREDENTIALS 且不带 remainingAttempts，不累计锁定', async () => {
      const name = uniqueUsername('grace');
      await prisma.user.create({
        data: {
          username: name,
          passwordHash: await auth.hashPassword(password),
          displayName: '格蕾丝',
        },
      });
      const login = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username: name, password });
      const { accessToken } = login.body as AuthBody;

      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ oldPassword: 'wrong-old', newPassword: 'New-Pass456' });
      expect(res.status).toBe(401);
      expect((res.body as ErrorBody).code).toBe('AUTH_INVALID_CREDENTIALS');
      // 改密失败不累计锁定（不带 remainingAttempts，failedAttempts 归零）
      expect((res.body as { detail?: unknown }).detail).toBeNull();

      const after = await prisma.user.findUnique({ where: { username: name } });
      expect(after?.failedAttempts).toBe(0);
      expect(after?.lockedUntil).toBeNull();

      // 原密码仍可正常登录（哈希未被改动）
      const relogin = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username: name, password });
      expect(relogin.status).toBe(201);
    });

    it('新密过短：400 VALIDATION_FAILED，哈希不变', async () => {
      const login = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username: uname, password });
      const { accessToken } = login.body as AuthBody;
      const before = await prisma.user.findUnique({ where: { username: uname } });

      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ oldPassword: password, newPassword: '123' });
      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).code).toBe('VALIDATION_FAILED');

      const after = await prisma.user.findUnique({ where: { username: uname } });
      expect(after?.passwordHash).toBe(before?.passwordHash);
    });
  });
});
