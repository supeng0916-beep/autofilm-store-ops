/** 批次5：技能版本留痕（skillVersion 落库）+ 一键回滚（快照目录内容替换）+
 * 影子模式首场景（intent_confirmed 聚合：AI 判级 vs 人工终判一致率）。 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';

import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  GatewayRunResult,
  OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

const password = 'S3cure-Passw0rd!';

class VGateway implements OpenClawGateway {
  last?: SubmitTaskRequest;
  submit(req: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.last = req;
    return Promise.resolve({ status: 'done', output: { reply: '（fake）' } });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve(void 0);
  }
}

describe('技能版本与影子模式（V1.5 批次5）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  const gateway = new VGateway();
  let bossToken = '';
  let salesToken = '';
  let bossId = '';
  // 快照目录沙箱（回滚测试用）
  const skillsDir = join(process.cwd(), 'uploads', 'test-skills');
  const leadIds: string[] = [];
  const eventIds: string[] = [];

  beforeAll(async () => {
    process.env.WG_OPENCLAW_SKILLS_DIR = skillsDir;
    mkdirSync(join(skillsDir, 'skill-boss-agent@v2'), { recursive: true });
    mkdirSync(join(skillsDir, 'skill-boss-agent@v1'), { recursive: true });
    mkdirSync(join(skillsDir, 'skill-boss-agent'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'skill-boss-agent@v1', 'SKILL.md'),
      '---\nname: skill-boss-agent\nversion: 1\n---\n# 当前\n',
    );
    writeFileSync(
      join(skillsDir, 'skill-boss-agent@v2', 'SKILL.md'),
      '---\nname: skill-boss-agent\nversion: 2\n---\n# v2 快照\n',
    );
    writeFileSync(
      join(skillsDir, 'skill-boss-agent', 'SKILL.md'),
      // 当前文件与注册表同步：boss 注册已升 v4（T2 决策留痕：输出加 reasoning）
      '---\nname: skill-boss-agent\nversion: 4\n---\n# 当前\n',
    );

    app = await buildApp(gateway);
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    for (const code of ['boss', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const mk = async (role: string) => {
      const username = uniqueUsername('v5');
      const user = await prisma.user.create({
        data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
      });
      const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
      const res = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({ username, password });
      return { token: (res.body as { accessToken: string }).accessToken, id: user.id };
    };
    const boss = await mk('boss');
    bossToken = boss.token;
    bossId = boss.id;
    salesToken = (await mk('sales_ops')).token;

    // 影子数据：3 条 intent_confirmed（2 一致 1 改判 high→medium）
    for (const [ai, human, i] of [
      ['high', 'high', 1],
      ['medium', 'medium', 2],
      ['high', 'medium', 3],
    ] as const) {
      const lead = await prisma.lead.create({
        data: { leadNo: `L-V5-${i}`, sourceCategory: 'offline', sourcePlatform: 't', stage: 'new' },
      });
      leadIds.push(lead.id);
      const ev = await prisma.leadEvent.create({
        data: {
          leadId: lead.id,
          kind: 'intent_confirmed',
          content: {
            taskId: `fake-${i}`,
            aiLevel: ai,
            humanLevel: human,
            overridden: ai !== human,
            ...(ai !== human ? { reason: '客户还在比价' } : {}),
          },
          operatorId: bossId,
        },
      });
      eventIds.push(ev.id);
    }
  });
  afterAll(async () => {
    await prisma.leadEvent.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
    await app.close();
    delete process.env.WG_OPENCLAW_SKILLS_DIR;
    rmSync(skillsDir, { recursive: true, force: true });
  });

  it('版本留痕：boss 对话任务落 skillVersion=注册版本', async () => {
    await request(app.getHttpServer() as Server)
      .post('/api/v1/agent/chat')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ message: '今天有什么要我拍板的？', history: [] })
      .expect(201);
    const row = await prisma.aiTask.findFirst({
      where: { taskType: 'boss.agent.chat' },
      orderBy: { createdAt: 'desc' },
    });
    // boss 注册已升 v4（agent.service.ts def.skillVersion: 4），首任务落注册版本
    expect(row?.skillVersion).toBe(4);
  });

  it('GET /ai/skills/versions：列出技能快照版本（system:manage 门禁）', async () => {
    const denied = await request(app.getHttpServer() as Server)
      .get('/api/v1/ai/skills/versions')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(denied.status).toBe(403);
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/ai/skills/versions')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    const boss = (
      res.body as Array<{ taskType: string; skillName: string; versions: number[] }>
    ).find((s) => s.skillName === 'skill-boss-agent');
    expect(boss?.versions).toContain(2);
  });

  it('POST /ai/skills/rollback：切换到 v2 快照（文件内容替换+注册表版本+审计），可回滚到 1', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/ai/skills/rollback')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ skillName: 'skill-boss-agent', version: 2 })
      .expect(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    // 文件被替换为 v2 内容
    const md = readFileSync(join(skillsDir, 'skill-boss-agent', 'SKILL.md'), 'utf8');
    expect(md).toContain('v2 快照');
    // 新任务落 v2 版本号
    await request(app.getHttpServer() as Server)
      .post('/api/v1/agent/chat')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ message: '再问一次', history: [] })
      .expect(201);
    const row = await prisma.aiTask.findFirst({
      where: { taskType: 'boss.agent.chat' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row?.skillVersion).toBe(2);
    // 回滚回 v1
    await request(app.getHttpServer() as Server)
      .post('/api/v1/ai/skills/rollback')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ skillName: 'skill-boss-agent', version: 1 })
      .expect(200);
    const back = readFileSync(join(skillsDir, 'skill-boss-agent', 'SKILL.md'), 'utf8');
    expect(back).toContain('# 当前');
  });

  it('影子意向面板：GET /ai/shadow/intent 聚合一致率与改判分布', async () => {
    const denied = await request(app.getHttpServer() as Server)
      .get('/api/v1/ai/shadow/intent')
      .set('Authorization', `Bearer ${salesToken}`);
    expect(denied.status).toBe(403);
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/ai/shadow/intent')
      .set('Authorization', `Bearer ${bossToken}`)
      .expect(200);
    const body = res.body as {
      total: number;
      agreed: number;
      agreementRate: number;
      overrides: Array<{ aiLevel: string; humanLevel: string; count: number }>;
      overrideSamples: Array<{ reason: string | null }>;
    };
    expect(body.total).toBeGreaterThanOrEqual(3);
    expect(body.agreementRate).toBeGreaterThan(0);
    const ov = body.overrides.find((o) => o.aiLevel === 'high' && o.humanLevel === 'medium');
    expect(ov?.count).toBeGreaterThanOrEqual(1);
    expect(body.overrideSamples.some((s) => s.reason?.includes('比价'))).toBe(true);
  });
});
