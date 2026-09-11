import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface UserRow {
  id: string;
  username: string;
  disabled: boolean;
  roles: string[];
}

describe('系统账号与角色管理（P1-02）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const newbieName = uniqueUsername('newbie');
  const password = 'S3cure-Passw0rd!';
  let adminToken = '';
  let salesToken = '';
  let bossToken = '';

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    // 确保 5 角色存在（与 rbac.spec 独立运行也不依赖执行顺序）
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder', 'sys_admin']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const mkUser = async (uname: string, role: string): Promise<string> => {
      const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
      const user = await prisma.user.create({
        data: {
          username: uname,
          passwordHash: await auth.hashPassword(password),
          displayName: uname,
        },
      });
      await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username: uname, password });
      return (res.body as { accessToken: string }).accessToken;
    };
    adminToken = await mkUser(uniqueUsername('admin'), 'sys_admin');
    salesToken = await mkUser(uniqueUsername('sales'), 'sales_ops');
    bossToken = await mkUser(uniqueUsername('bossrst'), 'boss');
  });

  afterAll(async () => {
    await app.close();
  });

  it('建号：sys_admin 创建用户并分配角色；非 sys_admin 被拒', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/system/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: newbieName, displayName: '新员工', password, roleCodes: ['sales_ops'] });
    expect(res.status).toBe(201);
    expect((res.body as { passwordHash?: string }).passwordHash).toBeUndefined();

    const denied = await request(app.getHttpServer() as Server)
      .post('/api/v1/system/users')
      .set('Authorization', `Bearer ${salesToken}`)
      .send({ username: uniqueUsername('x'), displayName: 'x', password, roleCodes: ['boss'] });
    expect(denied.status).toBe(403);
    expect((denied.body as { code: string }).code).toBe('PERM_DENIED');
  });

  it('角色变更即时生效并写审计（before/after 为角色码数组）', async () => {
    const target = await prisma.user.findUniqueOrThrow({
      where: { username: newbieName },
    });
    const res = await request(app.getHttpServer() as Server)
      .post(`/api/v1/system/users/${target.id}/roles`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roleCodes: ['store_manager'] });
    expect(res.status).toBe(201);

    const audits = await prisma.auditLog.findMany({
      where: { action: 'user.roles.changed', objectId: target.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.before).toEqual({ roleCodes: ['sales_ops'] });
    expect(audits[0]?.after).toEqual({ roleCodes: ['store_manager'] });
  });

  it('停用账号后无法登录（AUTH_ACCOUNT_DISABLED）', async () => {
    const target = await prisma.user.findUniqueOrThrow({
      where: { username: newbieName },
    });
    const res = await request(app.getHttpServer() as Server)
      .post(`/api/v1/system/users/${target.id}/disabled`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ disabled: true });
    expect(res.status).toBe(201);

    const login = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username: newbieName, password });
    expect(login.status).toBe(403);
    expect((login.body as { code: string }).code).toBe('AUTH_ACCOUNT_DISABLED');
  });

  it('用户列表不回传口令哈希', async () => {
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/system/users')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const rows = res.body as UserRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect((row as unknown as Record<string, unknown>).passwordHash).toBeUndefined();
    }
  });

  // ── 重启服务（2026-08-26 老板需求）：boss 硬校验 + 脚本缺位安全拒绝 ──

  it('重启服务：非 boss（sales_ops）403，且不留重启审计', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/system/services/restart')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('PERM_DENIED');
    expect(await prisma.auditLog.count({ where: { action: 'system.services_restart' } })).toBe(0);
  });

  it('重启服务：boss 但脚本缺位（开发/测试环境无 重启.command）→ 安全拒绝且不 spawn', async () => {
    // 测试进程 cwd=backend/，../../重启.command 不存在（包内才有）；WG_RESTART_SCRIPT 未配置
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/system/services/restart')
      .set('Authorization', `Bearer ${bossToken}`);
    expect([500, 502]).toContain(res.status);
    expect((res.body as { message: string }).message).toContain('重启脚本不可用');
    expect(await prisma.auditLog.count({ where: { action: 'system.services_restart' } })).toBe(0);
  });

  // ── 备份与诊断（2026-08-27 运维批次）：boss 硬校验 + 脚本缺位安全拒绝 + 诊断包内容 ──

  it('手动备份：非 boss 403；boss 但脚本缺位（测试环境无 ops/backup.sh）→ 安全拒绝', async () => {
    const forbidden = await request(app.getHttpServer() as Server)
      .post('/api/v1/system/backup/run')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(forbidden.status).toBe(403);
    expect((forbidden.body as { code: string }).code).toBe('PERM_DENIED');

    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/system/backup/run')
      .set('Authorization', `Bearer ${bossToken}`);
    expect([500, 502]).toContain(res.status);
    expect((res.body as { message: string }).message).toContain('备份脚本不可用');
  });

  it('备份状态：非 boss 403；boss 返回目录/份数结构（enabled 默认开启）', async () => {
    const forbidden = await request(app.getHttpServer() as Server)
      .get('/api/v1/system/backup-status')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(forbidden.status).toBe(403);

    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/system/backup-status')
      .set('Authorization', `Bearer ${bossToken}`);
    expect(res.status).toBe(200);
    const body = res.body as { enabled: boolean; dir: string; count: number; latest: unknown };
    expect(body.enabled).toBe(true); // WG_AUTO_BACKUP 未配置时默认开启
    expect(typeof body.dir).toBe('string');
    expect(typeof body.count).toBe('number');
  });

  it('诊断包：非 boss 403；boss 返回版本/AI 统计/备份/日志结构', async () => {
    const forbidden = await request(app.getHttpServer() as Server)
      .get('/api/v1/system/diagnostics')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(forbidden.status).toBe(403);

    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/system/diagnostics')
      .set('Authorization', `Bearer ${bossToken}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      version: { version: string };
      ai: { last7d: unknown[]; costFen7d: number };
      backups: { dir: string };
      logs: { run: string[]; gateway: string[] };
    };
    expect(body.version.version).toBeTruthy();
    expect(Array.isArray(body.ai.last7d)).toBe(true);
    expect(typeof body.backups.dir).toBe('string');
    expect(Array.isArray(body.logs.run)).toBe(true); // 测试环境无日志文件 → 空数组也是数组
  });
});
