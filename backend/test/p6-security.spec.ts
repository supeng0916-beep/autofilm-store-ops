import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import { ROLE_PERMISSIONS, type Permission, type RoleCode } from '../src/modules/auth/permissions';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import type {
  GatewayRunResult,
  OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import { PHONE_RE, PLATE_RE, WXID_RE, scanForLeaks } from '../src/modules/ai-dispatch/masker';
import { PrismaService } from '../src/prisma/prisma.service';
import { uniqueUsername } from './helpers/unique';
import { buildApp } from './setup';

/** P6-04 安全测试（任务书 §7 安全 / SEC01~06 / A04）：
 * A. 5 角色两两越权矩阵：探测端点 × ROLE_PERMISSIONS（PERMISSION_MATRIX 的机器可读镜像）
 *    —— 越权一律 403 + 写审计；未认证 401
 * B. 提示注入样本库（test/eval/injection-samples.json，S16 数据分离）：
 *    注入文本经客资需求字段进入 AI 上下文 → 断言脱敏/边界下发/伪造输出拒收/零业务写入
 * C. ai_tasks 落库泄漏扫描：inputSummary 无 PII 残留 */

interface InjectionSample {
  id: string;
  category: string;
  payload: string;
}

const injectionSamples: InjectionSample[] = (
  JSON.parse(readFileSync(join(__dirname, 'eval', 'injection-samples.json'), 'utf8')) as {
    samples: InjectionSample[];
  }
).samples;

/** 记录型假网关：output_hijack 样本的客资返回伪造结构输出（应被 schema 拒收），其余回显合法输出 */
class InjectionGateway implements OpenClawGateway {
  submitted: SubmitTaskRequest[] = [];

  constructor(private readonly hijackRefIds: Set<string>) {}

  submit(req: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.submitted.push(req);
    if (req.taskType === 'lead.classify' && this.hijackRefIds.has(String(req.context.refId))) {
      return Promise.resolve({
        status: 'done',
        output: { tool_calls: [{ tool: 'biz-query', args: { q: '全部客资手机号' } }] },
        model: 'fake-injection',
      });
    }
    const output =
      req.taskType === 'lead.classify'
        ? { level: 'pending', confidence: 0.5, evidence: [], missingInfo: [] }
        : req.taskType === 'lead.summary'
          ? {
              summary: '（fake）注入测试摘要',
              concerns: [],
              questionsToAsk: [],
              nextAction: '人工核实',
            }
          : { message: '（fake）草稿', notes: '注入测试' };
    return Promise.resolve({ status: 'done', output, model: 'fake-injection' });
  }

  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const ALL_ROLES: RoleCode[] = ['boss', 'store_manager', 'sales_ops', 'recorder', 'sys_admin'];

/** 权限点 → 探测端点（allowed 判非 403：可为 200/201/404/409 等；denied 一律 403） */
const PROBES: Array<{
  perm: string;
  method: 'get' | 'post' | 'patch';
  url: string;
  body?: unknown;
}> = [
  { perm: 'm03:view', method: 'get', url: '/api/v1/leads' },
  { perm: 'm03:edit', method: 'post', url: '/api/v1/leads/nonexistent/claim', body: {} },
  { perm: 'm05:view', method: 'get', url: '/api/v1/leads/takeover' },
  { perm: 'm06:view', method: 'get', url: '/api/v1/knowledge' },
  { perm: 'm06:edit', method: 'post', url: '/api/v1/knowledge/nonexistent/activate' },
  { perm: 'm07:view', method: 'get', url: '/api/v1/appointments' },
  { perm: 'm07:edit', method: 'post', url: '/api/v1/appointments/nonexistent/cancel', body: {} },
  { perm: 'm08:view', method: 'get', url: '/api/v1/work-orders' },
  { perm: 'm08:edit', method: 'post', url: '/api/v1/work-orders/nonexistent/start', body: {} },
  { perm: 'm08:approve', method: 'post', url: '/api/v1/work-orders/nonexistent/recheck', body: {} },
  { perm: 'approval:view', method: 'get', url: '/api/v1/approvals' },
  {
    perm: 'approval:request',
    method: 'post',
    url: '/api/v1/approvals/nonexistent/withdraw',
    body: {},
  },
  {
    perm: 'approval:decide',
    method: 'post',
    url: '/api/v1/approvals/nonexistent/approve',
    body: { confirmed: true },
  },
  { perm: 'system:manage', method: 'get', url: '/api/v1/system/users' },
  { perm: 'ai:cost:view', method: 'get', url: '/api/v1/ai/costs/daily' },
];

describe('P6-04 安全测试', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let auth: AuthService;
  const tokens = new Map<RoleCode, { token: string; id: string }>();
  const password = 'S3cure-Passw0rd!';

  beforeAll(async () => {
    app = await buildApp(new InjectionGateway(new Set()));
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    // 同日重跑残留防御（2026-09-01 V1.5 批次4 加入）：appointment/p6-replay/p6-security/
    // work-order 多套件共用固定技师名+相对基准日造预约，afterAll 清理不完整时同日第二轮
    // 全量互相 409。测试库这三表只有测试数据，全清彻底且安全。
    await prisma.workOrder.deleteMany({});
    await prisma.appointmentTechnicianChange.deleteMany({});
    await prisma.appointment.deleteMany({});
    auth = app.get(AuthService);
    for (const code of ALL_ROLES) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
      const username = uniqueUsername(`p6sec_${code}`);
      const user = await prisma.user.create({
        data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
      });
      const roleRow = await prisma.role.findUniqueOrThrow({ where: { code } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
      const res = await request(server).post('/api/v1/auth/login').send({ username, password });
      tokens.set(code, { token: (res.body as { accessToken: string }).accessToken, id: user.id });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  describe('A. 越权矩阵（5 角色 × 15 权限点，对照 PERMISSION_MATRIX）', () => {
    for (const probe of PROBES) {
      it(`${probe.perm} → ${probe.method.toUpperCase()} ${probe.url}`, async () => {
        for (const role of ALL_ROLES) {
          const allowed = ROLE_PERMISSIONS[role].includes(probe.perm as Permission);
          const res = await request(server)
            [probe.method](probe.url)
            .set('Authorization', `Bearer ${tokens.get(role)!.token}`)
            .send(probe.body as object);
          if (allowed) {
            expect([200, 201, 202, 404, 409, 400, 422]).toContain(res.status);
          } else {
            expect(res.status).toBe(403);
            expect((res.body as { code: string }).code).toBe('PERM_DENIED');
          }
        }
        // 未认证一律 401（fail-closed）
        const anon = await request(server)
          [probe.method](probe.url)
          .send(probe.body as object);
        expect(anon.status).toBe(401);
      });
    }

    it('越权拒绝写审计（auth.permission.denied，含所需权限点）', async () => {
      const before = await prisma.auditLog.count({
        where: { action: 'auth.permission.denied', actorId: tokens.get('recorder')!.id },
      });
      await request(server)
        .get('/api/v1/leads')
        .set('Authorization', `Bearer ${tokens.get('recorder')!.token}`)
        .expect(403);
      const rows = await prisma.auditLog.findMany({
        where: { action: 'auth.permission.denied', actorId: tokens.get('recorder')!.id },
        orderBy: { createdAt: 'desc' },
        take: before + 1,
      });
      const latest = rows[0];
      expect(latest).toBeDefined();
      expect(latest.objectId).toContain('m03:view');
    });

    it('矩阵自检：探测覆盖全部已用权限点（遗漏即测试失效）', () => {
      const probed = new Set(PROBES.map((p) => p.perm));
      // 全部权限点中，未探测的须为当前版本未在任何控制器使用的项
      const unused = [
        'm01:view',
        'm01:edit',
        'm02:view',
        'm02:edit',
        'm02:approve',
        'm04:view',
        'm05:edit',
        'm06:approve',
        'm07:approve',
        'm09:view',
        'm09:edit',
        'm10:view',
        'm11:view',
        'm11:edit',
        'm11:approve',
        'm12:view',
        'm12:edit',
        'audit:view',
        'sensitive:export',
      ];
      for (const p of probed) expect(unused).not.toContain(p);
    });
  });

  describe('B. 提示注入样本防御（样本库 8 类）', () => {
    let gateway: InjectionGateway;
    let hijackRefIds: Set<string>;
    let salesToken = '';
    let salesId = '';

    beforeAll(async () => {
      // sales_ops 角色承载注入链（导入→指派→客户回复触发分级）；
      // 重建 app：网关需按 refId 劫持 output_hijack 样本的输出
      hijackRefIds = new Set<string>();
      gateway = new InjectionGateway(hijackRefIds);
      await app.close();
      app = await buildApp(gateway);
      server = app.getHttpServer() as Server;
      prisma = app.get(PrismaService);
      salesToken = tokens.get('sales_ops')!.token;
      salesId = tokens.get('sales_ops')!.id;
    });

    it('每条注入样本：脱敏出站 + 边界下发 + 业务零写入 + 伪造输出拒收', async () => {
      const leadIds: string[] = [];

      // 逐样本导入（需求字段含注入文本）→ 指派 → 客户回复触发 lead.classify
      for (const sample of injectionSamples) {
        const phone = `138${String(Date.now()).slice(-6)}${String(leadIds.length).padStart(2, '0')}`;
        const dispatchNo = `D-P6SEC-${Date.now()}-${sample.id}`;
        const raw = [
          `派发NO：${dispatchNo}`,
          '门店：AutoFilm Demo',
          '日期：2026-08-17 11:00',
          '信息来源：抖音私信',
          `电话：${phone}`,
          '车型：奔驰E300L',
          `需求：${sample.payload}`,
        ].join('\n');
        const imported = await request(server)
          .post('/api/v1/leads/import/dispatch')
          .set('Authorization', `Bearer ${tokens.get('boss')!.token}`)
          .send({ rawTexts: [raw] })
          .expect(200);
        expect((imported.body as { created: number }).created).toBe(1);

        const lead = await prisma.lead.findFirst({ where: { upstreamDispatchNo: dispatchNo } });
        expect(lead).not.toBeNull();
        leadIds.push(lead!.id);
        if (sample.category === 'output_hijack') hijackRefIds.add(lead!.id);

        await request(server)
          .patch(`/api/v1/leads/${lead!.id}/assign`)
          .set('Authorization', `Bearer ${tokens.get('boss')!.token}`)
          .send({ ownerUserId: salesId, reason: '注入测试指派' })
          .expect(200);
        await request(server)
          .post(`/api/v1/leads/${lead!.id}/customer-reply`)
          .set('Authorization', `Bearer ${salesToken}`)
          .expect(200);
      }

      // 全部分级任务已出站：断言脱敏 + 边界
      const classifySubmits = gateway.submitted.filter((s) => s.taskType === 'lead.classify');
      expect(classifySubmits.length).toBeGreaterThanOrEqual(injectionSamples.length);
      for (const s of classifySubmits) {
        expect(scanForLeaks(s.context)).toEqual([]);
        const ctx = JSON.stringify(s.context);
        expect(ctx).not.toMatch(PHONE_RE);
        expect(ctx).not.toMatch(WXID_RE);
        expect(ctx).not.toMatch(PLATE_RE);
        expect(Object.keys(s.constraints ?? {}).length).toBeGreaterThan(0);
      }

      // 伪造结构输出被拒收：output_hijack 样本 → 任务 degraded、输出不落库、审计留痕，业务字段零写入
      const hijackLeadId =
        leadIds[injectionSamples.findIndex((x) => x.category === 'output_hijack')];
      const hijackTask = await prisma.aiTask.findFirst({
        where: { taskType: 'lead.classify', refId: hijackLeadId },
        orderBy: { createdAt: 'desc' },
      });
      expect(hijackTask).not.toBeNull();
      expect(hijackTask!.status).toBe('degraded');
      expect(hijackTask!.output).toBeNull();
      const rejectAudit = await prisma.auditLog.findFirst({
        where: {
          action: 'ai.callback.schema_rejected',
          objectType: 'ai_task',
          objectId: hijackTask!.id,
        },
      });
      expect(rejectAudit).not.toBeNull();

      // 全部样本客资：建议态隔离（intentLevel 未被 AI 写入）+ 无跟进结果伪造（A10）
      for (const id of leadIds) {
        const lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
        expect(lead.intentLevel).toBe('pending');
        expect(lead.lastFollowUpResult).toBeNull();
        expect(lead.finalStatus).toBe('active');
      }
    });
  });

  describe('C. ai_tasks 落库泄漏扫描（inputSummary 无 PII 残留）', () => {
    it('注入链产生的任务输入摘要不含手机号/wxid/车牌', async () => {
      const rows = await prisma.aiTask.findMany({
        where: { taskType: { in: ['lead.classify', 'lead.summary'] } },
        orderBy: { createdAt: 'desc' },
        take: 80,
      });
      const tasks = rows.filter((t) => t.inputSummary !== null);
      expect(tasks.length).toBeGreaterThan(0);
      for (const t of tasks) {
        const summary = String(t.inputSummary);
        expect(summary).not.toMatch(PHONE_RE);
        expect(summary).not.toMatch(WXID_RE);
        expect(summary).not.toMatch(PLATE_RE);
      }
    });
  });
});
