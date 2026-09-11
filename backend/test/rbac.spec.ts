import { Controller, Get, INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REAL_ACCOUNTS } from '../scripts/seed-accounts.data';
import { validateEnv } from '../src/common/config/env.schema';
import { setupApp } from '../src/common/setup-app';
import { AuditModule } from '../src/common/audit';
import { AuthModule } from '../src/modules/auth/auth.module';
import { AuthService } from '../src/modules/auth/auth.service';
import {
  PERMISSIONS,
  ROLE_CODES,
  ROLE_PERMISSIONS,
  permissionsOf,
  type Permission,
  type RoleCode,
} from '../src/modules/auth/permissions';
import { Public } from '../src/modules/auth/public.decorator';
import { RequirePermission } from '../src/modules/auth/require-permission.decorator';
import { SystemModule } from '../src/modules/system/system.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { uniqueUsername } from './helpers/unique';

/** 为每个权限点动态生成一个探针端点 GET /api/v1/probe/<perm>（测试专用，不进 AppModule）。
 * 装饰器经编程方式挂载：与 @Controller/@Get/@RequirePermission 的运行时语义一致。 */
function makeProbeController(perm: Permission): unknown {
  class ProbeController {
    handle(): { ok: boolean; perm: string } {
      return { ok: true, perm };
    }
  }
  const proto = ProbeController.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'handle')!;
  Get()(proto, 'handle', descriptor);
  Object.defineProperty(proto, 'handle', descriptor);
  const descriptor2 = Object.getOwnPropertyDescriptor(proto, 'handle')!;
  RequirePermission(perm)(proto, 'handle', descriptor2);
  Object.defineProperty(proto, 'handle', descriptor2);
  Controller(`probe/${perm.replace(/:/g, '-')}`)(ProbeController);
  return ProbeController;
}

/** @Public() + @RequirePermission() 组合探针（测试专用）：
 * 验证 PermissionGuard fail-closed——无会话时不得静默放行，必须 401。 */
function makePublicProbeController(perm: Permission): unknown {
  class PublicProbeController {
    handle(): { ok: boolean; perm: string } {
      return { ok: true, perm };
    }
  }
  const proto = PublicProbeController.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'handle')!;
  Get()(proto, 'handle', descriptor);
  Object.defineProperty(proto, 'handle', descriptor);
  const descriptor2 = Object.getOwnPropertyDescriptor(proto, 'handle')!;
  RequirePermission(perm)(proto, 'handle', descriptor2);
  Public()(proto, 'handle', descriptor2);
  Object.defineProperty(proto, 'handle', descriptor2);
  Controller(`public-probe/${perm.replace(/:/g, '-')}`)(PublicProbeController);
  return PublicProbeController;
}

describe('RBAC 权限模型（P1-02）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  const tokens: Record<RoleCode, string> = {} as Record<RoleCode, string>;
  const userIds: Record<RoleCode, string> = {} as Record<RoleCode, string>;

  beforeAll(async () => {
    process.env.WG_JWT_SECRET ??= 'test-only-secret-0246802789abcdef!!';

    const probeControllers = [
      ...PERMISSIONS.map(makeProbeController),
      makePublicProbeController('approval:view'),
    ];
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        PrismaModule,
        AuditModule,
        AuthModule,
        SystemModule,
      ],
      controllers: probeControllers as never[],
    }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);

    for (const code of ROLE_CODES) {
      const role = await prisma.role.upsert({
        where: { code },
        update: {},
        create: { code, name: `角色-${code}` },
      });
      // 用户名经 uniqueUsername（P1 遗留 T8-1 回收）：随机段保证跨套件不撞唯一键
      const username = uniqueUsername(code);
      const user = await prisma.user.create({
        data: {
          username,
          passwordHash: await auth.hashPassword(password),
          displayName: `测试-${code}`,
        },
      });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
      userIds[code] = user.id;
      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username, password });
      tokens[code] = (res.body as { accessToken: string }).accessToken;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  // 验收核心：权限矩阵中每个「禁止」项都有用例——对 PERMISSIONS 全量 × 5 角色参数化，
  // ROLE_PERMISSIONS 未授予的权限点必须 403 PERM_DENIED，授予的必须 200。
  for (const role of ROLE_CODES) {
    for (const perm of PERMISSIONS) {
      const granted = ROLE_PERMISSIONS[role].includes(perm);
      it(`${role} × ${perm} → ${granted ? '200' : '403 PERM_DENIED'}`, async () => {
        const res = await request(app.getHttpServer() as Server)
          .get(`/api/v1/probe/${perm.replace(/:/g, '-')}`)
          .set('Authorization', `Bearer ${tokens[role]}`);
        if (granted) {
          expect(res.status).toBe(200);
        } else {
          expect(res.status).toBe(403);
          expect((res.body as { code: string }).code).toBe('PERM_DENIED');
        }
      });
    }
  }

  it('无 token 访问 @RequirePermission 探针端点 → 401 UNAUTHORIZED（认证先于授权）', async () => {
    const res = await request(app.getHttpServer() as Server).get('/api/v1/probe/approval-view');
    expect(res.status).toBe(401);
    expect((res.body as { code: string }).code).toBe('UNAUTHORIZED');
  });

  it('@Public() 与 @RequirePermission() 同标时仍须认证（PermissionGuard fail-closed）', async () => {
    const res = await request(app.getHttpServer() as Server).get(
      '/api/v1/public-probe/approval-view',
    );
    expect(res.status).toBe(401);
    expect((res.body as { code: string }).code).toBe('UNAUTHORIZED');
  });

  it('越权访问写审计（退出标准：被拒并留痕）', async () => {
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/probe/m03-edit')
      .set('Authorization', `Bearer ${tokens.recorder}`);
    expect(res.status).toBe(403);
    // 参数化矩阵已为 recorder 写过其它拒绝审计，故用 some 断言本次 m03:edit 拒绝留痕
    const rows = await prisma.auditLog.findMany({
      where: { action: 'auth.permission.denied', actorId: userIds.recorder },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => (r.objectId ?? '').includes('m03:edit'))).toBe(true);
  });

  it('角色变更即时生效（无缓存）', async () => {
    // recorder 默认无 audit:view → 403
    const probe = '/api/v1/probe/audit-view';
    const before = await request(app.getHttpServer() as Server)
      .get(probe)
      .set('Authorization', `Bearer ${tokens.recorder}`);
    expect(before.status).toBe(403);

    // 直接改 user_roles 模拟角色管理（端点流程在 system.spec.ts 覆盖）：挂 store_manager 验证生效
    const managerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'store_manager' } });
    await prisma.userRole.create({ data: { userId: userIds.recorder, roleId: managerRole.id } });
    const after = await request(app.getHttpServer() as Server)
      .get(probe)
      .set('Authorization', `Bearer ${tokens.recorder}`);
    expect(after.status).toBe(200);
  });

  // 必须最后执行：停用 recorder 账号，后续无用例再依赖该账号
  it('停用账号的未过期令牌被授权守卫拒绝（AUTH_ACCOUNT_DISABLED）', async () => {
    await prisma.user.update({ where: { id: userIds.recorder }, data: { disabled: true } });
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/probe/m06-view')
      .set('Authorization', `Bearer ${tokens.recorder}`);
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('AUTH_ACCOUNT_DISABLED');
  });
});

/** 两个演示经营者账号权限一致；同时验证 boss 覆盖运营角色并集。 */
describe('演示经营者账号权限一致性', () => {
  it("权限包含：permissionsOf(['boss']) ⊇ 老板娘原三角色并集", () => {
    const boss = permissionsOf(['boss']);
    const legacyUnion = permissionsOf(['sales_ops', 'recorder', 'store_manager']);
    // 防断言空转恒真：旧角色码若被改名/移除，permissionsOf 返回空集，上行比较形同虚设
    expect(legacyUnion.size).toBeGreaterThan(0);
    const missing = [...legacyUnion].filter((p) => !boss.has(p));
    // 若此断言失败：有人削减了 boss 权限，老板娘改挂 ['boss'] 后将丢功能
    expect(missing).toEqual([]);
  });

  it('种子定义中老板娘与老板角色完全一致（均为单一 boss）', () => {
    const mboss = REAL_ACCOUNTS.find((a) => a.username === 'demo-owner-a');
    const fboss = REAL_ACCOUNTS.find((a) => a.username === 'demo-owner-b');
    expect(mboss).toBeDefined();
    expect(fboss).toBeDefined();
    expect([...fboss!.roles].sort()).toEqual([...mboss!.roles].sort());
    expect(fboss!.roles).toEqual(['boss']);
  });
});
