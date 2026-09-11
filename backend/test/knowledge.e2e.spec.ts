import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface ErrorBody {
  code: string;
}

/** 知识库模块集成测试（P4-01）：CRUD + 版本管理 + 价格审批 + 权限校验 */
describe('知识库模块（P4-01）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const password = 'S3cure-Passw0rd!';
  let bossToken = '';
  let managerToken = '';
  let salesToken = '';
  let bossId = '';

  const mkUser = async (uname: string, role: string): Promise<{ token: string; id: string }> => {
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
    return { token: (res.body as { accessToken: string }).accessToken, id: user.id };
  };

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    // 同日重跑残留防御（V1.5 批次6a 加入）：固定 key 测试条目（test-*）残留时状态迁移断言连锁挂，
    // 开跑前清一轮（测试条目仅本套件使用）
    await prisma.knowledgeItem.deleteMany({ where: { key: { startsWith: 'test-' } } });
    auth = app.get(AuthService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const boss = await mkUser(uniqueUsername('k4_boss'), 'boss');
    bossToken = boss.token;
    bossId = boss.id;
    const manager = await mkUser(uniqueUsername('k4_manager'), 'store_manager');
    managerToken = manager.token;
    const sales = await mkUser(uniqueUsername('k4_sales'), 'sales_ops');
    salesToken = sales.token;
    // recorder 也创建，用于权限越权测试
    await mkUser(uniqueUsername('k4_recorder'), 'recorder');
  });

  afterAll(async () => {
    await app.close();
  });

  /** 创建一条知识条目，返回 id */
  const createItem = async (
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/knowledge')
      .set('Authorization', `Bearer ${token}`)
      .send({
        kind: 'product',
        key: `test-item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: '测试产品',
        content: '这是测试产品的内容描述',
        source: '品牌官方手册',
        licensed: false,
        ...overrides,
      });
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  };

  // ─── CRUD 基本操作 ───

  describe('CRUD', () => {
    it('店长可创建知识条目（status=draft, version=1）', async () => {
      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/knowledge')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({
          kind: 'product',
          key: 'test-product-dm04',
          title: '演示品牌 DM04',
          content: '顶级前挡膜，透光率 70%',
          source: '演示品牌官方手册',
          licensed: true,
        });
      expect(res.status).toBe(201);
      const body = res.body as Record<string, unknown>;
      expect(body.kind).toBe('product');
      expect(body.key).toBe('test-product-dm04');
      expect(body.status).toBe('draft');
      expect(body.version).toBe(1);
    });

    it('销售可查看知识条目列表', async () => {
      await createItem(managerToken, { key: 'test-list-item', kind: 'product', title: '列表测试' });
      const res = await request(app.getHttpServer() as Server)
        .get('/api/v1/knowledge')
        .set('Authorization', `Bearer ${salesToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('可按 kind 过滤列表', async () => {
      await createItem(managerToken, {
        key: 'test-filter-item',
        kind: 'warranty',
        title: '质保测试',
      });
      const res = await request(app.getHttpServer() as Server)
        .get('/api/v1/knowledge?kind=warranty')
        .set('Authorization', `Bearer ${salesToken}`);
      expect(res.status).toBe(200);
      for (const item of res.body as Record<string, unknown>[]) {
        expect(item.kind).toBe('warranty');
      }
    });

    it('销售不可创建知识条目（m06:edit 缺失）', async () => {
      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/knowledge')
        .set('Authorization', `Bearer ${salesToken}`)
        .send({
          kind: 'product',
          key: 'test-sales-create',
          title: '销售尝试创建',
          content: 'test',
        });
      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).code).toBe('PERM_DENIED');
    });

    it('不存在条目返回 404', async () => {
      const res = await request(app.getHttpServer() as Server)
        .get('/api/v1/knowledge/nonexistent-id')
        .set('Authorization', `Bearer ${salesToken}`);
      expect(res.status).toBe(404);
    });
  });

  // ─── 版本管理 ───

  describe('版本管理', () => {
    it('编辑 draft 条目 → 同版本覆盖', async () => {
      const id = await createItem(managerToken, { key: 'test-draft-edit', title: '原始标题' });
      const res = await request(app.getHttpServer() as Server)
        .patch(`/api/v1/knowledge/${id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ title: '修改后标题' });
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.title).toBe('修改后标题');
      expect(body.version).toBe(1); // 同版本
    });

    it('生效后编辑 → 生成新版本，旧版本过期', async () => {
      // 创建并生效
      const id = await createItem(managerToken, { key: 'test-version-edit', title: 'V1' });
      await request(app.getHttpServer() as Server)
        .post(`/api/v1/knowledge/${id}/activate`)
        .set('Authorization', `Bearer ${managerToken}`);

      // 编辑生效条目
      const res = await request(app.getHttpServer() as Server)
        .patch(`/api/v1/knowledge/${id}`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ title: 'V2' });
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.title).toBe('V2');
      expect(body.version).toBe(2); // 新版本
      expect(body.status).toBe('draft');

      // 旧版本已过期
      const old = await prisma.knowledgeItem.findUnique({ where: { id } });
      expect(old?.status).toBe('expired');
    });

    it('可查看版本历史', async () => {
      const id = await createItem(managerToken, { key: 'test-version-history', title: 'V1' });
      const res = await request(app.getHttpServer() as Server)
        .get(`/api/v1/knowledge/${id}/versions`)
        .set('Authorization', `Bearer ${salesToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  // ─── 状态迁移 ───

  describe('状态迁移', () => {
    it('非价格条目 → 直接生效', async () => {
      const id = await createItem(managerToken, { key: 'test-product-activate', kind: 'product' });
      const res = await request(app.getHttpServer() as Server)
        .post(`/api/v1/knowledge/${id}/activate`)
        .set('Authorization', `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.status).toBe('active');
    });

    it('价格条目 → 创建审批项', async () => {
      const id = await createItem(managerToken, {
        key: 'test-price-activate',
        kind: 'price',
        title: '标准报价',
      });
      const res = await request(app.getHttpServer() as Server)
        .post(`/api/v1/knowledge/${id}/activate`)
        .set('Authorization', `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.approvalId).toBeTruthy();
      expect((body.item as Record<string, unknown>).status).toBe('draft'); // 审批通过前保持 draft
    });

    it('价格审批通过后自动生效', async () => {
      // 创建价格条目
      const id = await createItem(managerToken, {
        key: 'test-price-approve',
        kind: 'price',
        title: '价格审批测试',
      });
      const activateRes = await request(app.getHttpServer() as Server)
        .post(`/api/v1/knowledge/${id}/activate`)
        .set('Authorization', `Bearer ${managerToken}`);
      const approvalId = (activateRes.body as Record<string, unknown>).approvalId as string;

      // 老板审批通过
      const approveRes = await request(app.getHttpServer() as Server)
        .post(`/api/v1/approvals/${approvalId}/approve`)
        .set('Authorization', `Bearer ${bossToken}`)
        .send({ confirmed: true });
      expect(approveRes.status).toBe(201);

      // 知识条目已生效
      const item = await prisma.knowledgeItem.findUnique({ where: { id } });
      expect(item?.status).toBe('active');
      expect(item?.approvedBy).toBe(bossId);
    });

    it('生效 → 过期', async () => {
      const id = await createItem(managerToken, { key: 'test-expire', kind: 'product' });
      await request(app.getHttpServer() as Server)
        .post(`/api/v1/knowledge/${id}/activate`)
        .set('Authorization', `Bearer ${managerToken}`);

      const res = await request(app.getHttpServer() as Server)
        .post(`/api/v1/knowledge/${id}/expire`)
        .set('Authorization', `Bearer ${managerToken}`);
      expect(res.status).toBe(200);

      const item = await prisma.knowledgeItem.findUnique({ where: { id } });
      expect(item?.status).toBe('expired');
    });

    it('过期条目不可再过期', async () => {
      const id = await createItem(managerToken, { key: 'test-expire-twice', kind: 'product' });
      await request(app.getHttpServer() as Server)
        .post(`/api/v1/knowledge/${id}/expire`)
        .set('Authorization', `Bearer ${managerToken}`);

      const res = await request(app.getHttpServer() as Server)
        .post(`/api/v1/knowledge/${id}/expire`)
        .set('Authorization', `Bearer ${managerToken}`);
      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).code).toBe('KNOWLEDGE_INVALID_STATE');
    });
  });

  // ─── 审计日志 ───

  describe('审计', () => {
    it('创建/生效/过期均留痕', async () => {
      const id = await createItem(managerToken, { key: 'test-audit', kind: 'product' });
      await request(app.getHttpServer() as Server)
        .post(`/api/v1/knowledge/${id}/activate`)
        .set('Authorization', `Bearer ${managerToken}`);
      await request(app.getHttpServer() as Server)
        .post(`/api/v1/knowledge/${id}/expire`)
        .set('Authorization', `Bearer ${managerToken}`);

      const logs = await prisma.auditLog.findMany({
        where: { objectType: 'knowledge_item', objectId: id },
        orderBy: { createdAt: 'asc' },
      });
      expect(logs.length).toBeGreaterThanOrEqual(3); // created + activated + expired
      const actions = logs.map((l) => l.action);
      expect(actions).toContain('knowledge.created');
      expect(actions).toContain('knowledge.activated');
      expect(actions).toContain('knowledge.expired');
    });
  });

  // ─── 知识源文件只读（#14 门店知识源/） ───

  describe('知识源文件只读（#14）', () => {
    const get = (token: string, path: string) =>
      request(app.getHttpServer() as Server)
        .get('/api/v1/knowledge/source-file')
        .query({ path })
        .set('Authorization', `Bearer ${token}`);

    it('白名单内 .md 返回 200（path+content）', async () => {
      const res = await get(salesToken, '门店知识源/00-索引.md');
      expect(res.status).toBe(200);
      const body = res.body as { path: string; content: string };
      expect(body.path).toBe('门店知识源/00-索引.md');
      expect(body.content).toContain('门店知识源');
    });

    it('仓库其他目录路径 403（前缀白名单）', async () => {
      const res = await get(salesToken, 'backend/package.json');
      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).code).toBe('FORBIDDEN');
    });

    it('..穿越与绝对路径均 403', async () => {
      const escape1 = await get(salesToken, '门店知识源/../backend/package.md');
      expect(escape1.status).toBe(403);
      const escape2 = await get(salesToken, '/etc/passwd.md');
      expect(escape2.status).toBe(403);
      const escape3 = await get(salesToken, '门店知识源/01-产品/../../backend/package.md');
      expect(escape3.status).toBe(403);
    });

    it('非 .md 后缀拒绝 403', async () => {
      const res = await get(salesToken, '门店知识源/报价图.jpg');
      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).code).toBe('FORBIDDEN');
    });

    it('白名单内但文件不存在 404', async () => {
      const res = await get(salesToken, '门店知识源/99-不存在.md');
      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).code).toBe('NOT_FOUND');
    });
  });
});
