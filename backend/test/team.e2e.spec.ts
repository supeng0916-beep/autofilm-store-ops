import type { Server } from 'node:http';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AiTaskRegistry } from '../src/modules/ai-dispatch/ai-dispatch.registry';
import { AuthService } from '../src/modules/auth/auth.service';
import { SEED_TECHNICIANS } from '../src/modules/team/team.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface TechCard {
  id: string;
  kind: string;
  name: string;
  skills: string[];
  active: boolean;
  currentWorkOrder: { orderNo: string; stage: string } | null;
  stats: { total: number; delivered: number; rework: number; revenueFen: number };
}

interface AgentRow {
  taskType: string;
  skillName: string;
  kind: string;
  recent30d: {
    total: number;
    doneRate: number;
    avgSeconds: number | null;
    lastRunAt: string | null;
  };
}

interface RecordRow {
  id: string;
  subjectType: string;
  subjectId: string;
  subjectName: string | null;
  kind: string;
  content: string;
  occurredAt: string;
  recordedBy: string;
  recorderName: string | null;
  createdAt: string;
}

interface OverviewBody {
  technicians: TechCard[];
  agents: AgentRow[];
  records: RecordRow[];
}

/** 人机团队集成测试（V2.4 Task2 + v1.5 §5.4）：合成演示配置种子同步/技师指标聚合（口径同 analytics，
 * 含产值去重）/Agent 花名册近 30 天聚合/记录录入与写权限边界（服务层 boss|store_manager 硬校验）。
 * 精确断言只落在本轮 tag 唯一造数上，不碰全库计数；演示种子等存量数据仅做成员断言。 */
describe('人机团队（V2.4）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let registry: AiTaskRegistry;
  const password = 'S3cure-Passw0rd!';
  const tag = Math.random().toString(36).slice(2, 8);
  let managerToken = '';
  let managerId = '';
  let salesToken = '';
  let recorderToken = '';
  let bossToken = '';

  const techName = `团队测师${tag}`;
  const renamedTechName = `团队测师改${tag}`;
  const agentTaskType = `team.agent.${tag}`;
  const leadNo = `L-TM-${tag}-0001`;
  const woInProgressNo = `W-TM-${tag}-0001`;
  const woDeliveredNo = `W-TM-${tag}-0002`;
  const pendingTechName = `团队待入师${tag}`;
  const woPendingNo = `W-TM-${tag}-0003`;

  let techId = '';
  let agentLastRunAt = '';

  const api = (method: 'get' | 'post' | 'patch', url: string, token?: string) => {
    const req = request(app.getHttpServer() as Server)[method](url);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

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
    app = await buildApp(); // OnModuleInit：v1.5 种子同步（空表创建演示人员；残留占位清退、按名补缺）
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    registry = app.get(AiTaskRegistry);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const manager = await mkUser(uniqueUsername('tm_mgr'), 'store_manager');
    managerToken = manager.token;
    managerId = manager.id;
    salesToken = (await mkUser(uniqueUsername('tm_sales'), 'sales_ops')).token;
    recorderToken = (await mkUser(uniqueUsername('tm_rec'), 'recorder')).token;
    bossToken = (await mkUser(uniqueUsername('tm_boss'), 'boss')).token;

    // 残留防御：上次异常中断的运行可能留下未清理的 staff_records（本表唯一写入方是本套件，
    // 记录录入人均为 tm_ 前缀测试用户），清掉保证下方「records 空」断言确定性
    const staleUsers = await prisma.user.findMany({
      where: { username: { startsWith: 'tm_' } },
      select: { id: true },
    });
    if (staleUsers.length > 0) {
      await prisma.staffRecord.deleteMany({
        where: { recordedBy: { in: staleUsers.map((u) => u.id) } },
      });
    }

    // 本轮唯一造数：技师 + won 客资 + 两张施工单（1 施工中 / 1 已交付返工，同客资验产值去重）
    const tech = await prisma.technician.create({ data: { name: techName } });
    techId = tech.id;
    const lead = await prisma.lead.create({
      data: {
        leadNo,
        sourceCategory: 'offline',
        sourcePlatform: '测试',
        finalStatus: 'won',
        closedAmountFen: 100000,
      },
    });
    await prisma.workOrder.create({
      data: {
        orderNo: woInProgressNo,
        technicianName: techName,
        stage: 'in_progress',
        leadId: lead.id,
      },
    });
    await prisma.workOrder.create({
      data: {
        orderNo: woDeliveredNo,
        technicianName: techName,
        stage: 'delivered',
        rework: true,
        leadId: lead.id,
      },
    });
    // 回归造数（2026-08-28 忙闲修复）：仅持待入场单的技师也算有活，不得显示空闲
    await prisma.technician.create({ data: { name: pendingTechName } });
    await prisma.workOrder.create({
      data: { orderNo: woPendingNo, technicianName: pendingTechName, stage: 'pending' },
    });

    // Agent 花名册：注册本轮唯一 taskType（registry 为代码事实，测试内注册合法）+
    // 三笔近 30 天任务（2 done 各 3600s/1800s + 1 failed 最新）→ total 3 / done 率 2/3 / 均耗时 2700s
    registry.register({
      taskType: agentTaskType,
      skillName: `skill-team-${tag}`,
      outputSchema: z.object({ ok: z.boolean() }),
    });
    const now = Date.now();
    const lastRun = new Date(now - 3600_000);
    agentLastRunAt = lastRun.toISOString();
    await prisma.aiTask.createMany({
      data: [
        {
          taskType: agentTaskType,
          status: 'done',
          inputSummary: 'team-test',
          createdAt: new Date(now - 3 * 3600_000),
          finishedAt: new Date(now - 2 * 3600_000),
        },
        {
          taskType: agentTaskType,
          status: 'done',
          inputSummary: 'team-test',
          createdAt: new Date(now - 5 * 3600_000),
          finishedAt: new Date(now - 5 * 3600_000 + 1800_000),
        },
        {
          taskType: agentTaskType,
          status: 'failed',
          inputSummary: 'team-test',
          createdAt: lastRun,
        },
      ],
    });
  });

  afterAll(async () => {
    // 按本轮 tag 清理（演示种子留库：OnModuleInit 幂等；测试用户沿 asset spec 先例不回收）
    await prisma.aiTask.deleteMany({ where: { taskType: agentTaskType } });
    await prisma.staffRecord.deleteMany({ where: { content: { contains: tag } } });
    await prisma.workOrder.deleteMany({ where: { orderNo: { contains: `W-TM-${tag}` } } });
    await prisma.lead.deleteMany({ where: { leadNo: { contains: tag } } });
    await prisma.technician.deleteMany({ where: { name: { contains: tag } } });
    await app.close();
  });

  it('①店长 GET /team/overview：演示种子在册、技师指标聚合正确、Agent 花名册带 kind 与近 30 天聚合、records 空', async () => {
    const res = await api('get', '/api/v1/team/overview', managerToken).expect(200);
    const body = res.body as OverviewBody;

    // v1.5 八师技能矩阵种子（成员断言，不碰全库计数）；旧占位师傅A~E 已被同步清退
    const names = body.technicians.map((t) => t.name);
    for (const seed of SEED_TECHNICIANS) {
      expect(names).toContain(seed.name);
    }
    expect(names.filter((n) => n.startsWith('师傅'))).toHaveLength(0);

    // 本轮技师指标精确：2 单（1 施工中 1 已交付返工）；产值同客资去重只计一次；
    // 忙闲=施工中单号
    const card = body.technicians.find((t) => t.name === techName);
    expect(card).toBeDefined();
    expect(card!.kind).toBe('technician');
    expect(card!.currentWorkOrder).toEqual({ orderNo: woInProgressNo, stage: 'in_progress' });
    const pendingCard = body.technicians.find((t) => t.name === pendingTechName);
    expect(pendingCard).toBeDefined();
    expect(pendingCard!.currentWorkOrder).toEqual({ orderNo: woPendingNo, stage: 'pending' });
    expect(card!.stats).toEqual({ total: 2, delivered: 1, rework: 1, revenueFen: 100000 });

    // Agent 花名册：与 registry 全量 taskType 一一对应且带 kind:'agent'
    const registryTypes = registry.list().map((d) => d.taskType);
    const agentTypes = body.agents.map((a) => a.taskType);
    expect(new Set(agentTypes)).toEqual(new Set(registryTypes));
    // 本轮唯一 agent 聚合精确（其他套件可能积累 hello 等任务，不碰）
    const agent = body.agents.find((a) => a.taskType === agentTaskType);
    expect(agent).toBeDefined();
    expect(agent!.kind).toBe('agent');
    expect(agent!.skillName).toBe(`skill-team-${tag}`);
    expect(agent!.recent30d).toEqual({
      total: 3,
      doneRate: 0.667,
      avgSeconds: 2700,
      lastRunAt: agentLastRunAt,
    });

    // staff_records 新表无写入 → 空
    expect(body.records).toEqual([]);
  });

  it('②店长 POST /team/records 201 且 recordedBy 落库；sales 403 无副作用', async () => {
    const occurredAt = new Date(Date.now() - 86_400_000).toISOString();
    const res = await api('post', '/api/v1/team/records', managerToken)
      .send({ subjectId: techId, kind: 'reward', content: `全勤奖励${tag}`, occurredAt })
      .expect(201);
    const row = res.body as RecordRow;
    expect(row.subjectType).toBe('technician');
    expect(row.subjectId).toBe(techId);
    expect(row.subjectName).toBe(techName);
    expect(row.kind).toBe('reward');
    expect(row.occurredAt).toBe(occurredAt);
    expect(row.recordedBy).toBe(managerId);
    // 库内一致（recordedBy 落库 + subjectType 固定 technician）
    const dbRow = await prisma.staffRecord.findUniqueOrThrow({ where: { id: row.id } });
    expect(dbRow.recordedBy).toBe(managerId);
    expect(dbRow.subjectType).toBe('technician');
    expect(dbRow.kind).toBe('reward');
    // 总览记录区可见
    const overview = await api('get', '/api/v1/team/overview', managerToken).expect(200);
    expect(
      (overview.body as OverviewBody).records.some(
        (r) => r.id === row.id && r.subjectId === techId && r.recorderName !== null,
      ),
    ).toBe(true);

    // sales 写 → 403 PERM_DENIED，无副作用
    const denied = await api('post', '/api/v1/team/records', salesToken)
      .send({ subjectId: techId, kind: 'punish', content: `越权处罚${tag}`, occurredAt })
      .expect(403);
    expect((denied.body as { code: string }).code).toBe('PERM_DENIED');
    expect(await prisma.staffRecord.findFirst({ where: { content: `越权处罚${tag}` } })).toBeNull();
  });

  it('③店长 PATCH /team/technicians/:id 改名后 overview 反映；sales 403；伪造 id 404', async () => {
    const res = await api('patch', `/api/v1/team/technicians/${techId}`, managerToken)
      .send({ name: renamedTechName })
      .expect(200);
    expect((res.body as { name: string }).name).toBe(renamedTechName);

    const overview = await api('get', '/api/v1/team/overview', managerToken).expect(200);
    const names = (overview.body as OverviewBody).technicians.map((t) => t.name);
    expect(names).toContain(renamedTechName);
    expect(names).not.toContain(techName);

    await api('patch', `/api/v1/team/technicians/${techId}`, salesToken)
      .send({ name: `越权改名${tag}` })
      .expect(403);
    expect(await prisma.technician.findFirst({ where: { name: `越权改名${tag}` } })).toBeNull();
    await api('patch', '/api/v1/team/technicians/nonexistent', managerToken)
      .send({ name: 'x' })
      .expect(404);
  });

  it('④店长 POST /team/technicians 新建；recorder GET 200（m08:view）；sales 新建 403', async () => {
    const res = await api('post', '/api/v1/team/technicians', managerToken)
      .send({ name: `新增技师${tag}`, skills: ['color_change', 'car_cover'] })
      .expect(201);
    const created = res.body as {
      id: string;
      name: string;
      skills: string[];
      active: boolean;
    };
    expect(created.name).toBe(`新增技师${tag}`);
    // v1.5：skills 为工种数组（String[]），取值 window_film/car_cover/color_change
    expect(created.skills).toEqual(['color_change', 'car_cover']);
    expect(created.active).toBe(true);

    // recorder 持 m08:view 可看总览
    await api('get', '/api/v1/team/overview', recorderToken).expect(200);
    // sales 建档 → 403 无副作用
    await api('post', '/api/v1/team/technicians', salesToken)
      .send({ name: `越权技师${tag}` })
      .expect(403);
    expect(await prisma.technician.findFirst({ where: { name: `越权技师${tag}` } })).toBeNull();
  });

  it('⑤合成种子入库且技能配置正确', async () => {
    const rows = await prisma.technician.findMany({ orderBy: { name: 'asc' } });
    const byName = new Map(rows.map((t) => [t.name, t.skills]));
    expect(byName.get('演示技师 A')).toEqual(['window_film', 'color_change']);
    expect(byName.get('演示技师 B')).toEqual(['car_cover']);
    expect(byName.get('演示技师 C')).toEqual(['window_film', 'car_cover']);
    expect(rows.filter((t) => t.name.startsWith('师傅')).length).toBe(0);
  });

  it('⑥PATCH 技师 skills 非法枚举被拒（422）', async () => {
    const t = await prisma.technician.findFirst({
      where: { name: '演示技师 A' },
      orderBy: { createdAt: 'asc' },
    });
    const res = await api('patch', `/api/v1/team/technicians/${t!.id}`, bossToken).send({
      skills: ['window_film', 'polish'],
    });
    expect(res.status).toBe(422);
  });
});
