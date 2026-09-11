/** 行业晨报（V1.5 批次4）：贴膜行业/演示品牌品牌/本地消费趋势资讯简报——复用同行动态日报的
 * 巡检/补跑/幂等模式与 web_search 通道（口径 A 合规），推送 boss∪persona 映射 boss（老板）。 */
import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  GatewayRunResult,
  OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import { IndustryDailyService } from '../src/modules/marketing/industry-daily.service';
import { PersonaService } from '../src/modules/agent/persona.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

const password = 'S3cure-Passw0rd!';

class IndustryGateway implements OpenClawGateway {
  last?: SubmitTaskRequest;
  submit(req: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.last = req;
    const output =
      req.taskType === 'sales.agent.chat'
        ? {
            reply:
              '行业简报：①演示品牌发布新代窗膜产品线（来源：品牌官网新闻）。②本地汽车消费补贴政策延续至年底（来源：政务公开网）。仅供参考。',
          }
        : { greeting: '你好（fake）', model: 'fake' };
    return Promise.resolve({ status: 'done', output });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve(void 0);
  }
}

describe('行业晨报（V1.5 批次4）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let industry: IndustryDailyService;
  let persona: PersonaService;
  const gateway = new IndustryGateway();
  let bossId = '';
  let salesId = '';

  beforeAll(async () => {
    app = await buildApp(gateway);
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    industry = app.get(IndustryDailyService);
    persona = app.get(PersonaService);
    for (const code of ['boss', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const mk = async (role: string) => {
      const username = uniqueUsername('id');
      const user = await prisma.user.create({
        data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
      });
      const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
      return user.id;
    };
    bossId = await mk('boss');
    salesId = await mk('sales_ops');
    // 隔离残留
    await prisma.systemMeta.deleteMany({ where: { key: { contains: 'industry.daily.' } } });
    await prisma.notification.deleteMany({ where: { kind: 'industry.daily' } });
  });
  afterAll(async () => {
    await prisma.systemMeta.deleteMany({ where: { key: { contains: 'industry.daily.' } } });
    await prisma.notification.deleteMany({ where: { kind: 'industry.daily' } });
    await app.close();
  });

  it('runIfDue：生成行业简报（复用 sales.agent.chat 通道）并只推送 boss 角色用户', async () => {
    const res = await industry.runIfDue();
    expect(res.generated).toBe(true);
    expect(gateway.last?.taskType).toBe('sales.agent.chat');
    expect(String(gateway.last?.context?.message)).toContain('行业');
    const notified = await prisma.notification.findMany({
      where: { kind: 'industry.daily' },
      select: { userId: true },
    });
    expect(notified.map((n) => n.userId)).toContain(bossId);
    expect(notified.map((n) => n.userId)).not.toContain(salesId);
  });

  it('幂等：当天已生成 → already-done', async () => {
    const res = await industry.runIfDue();
    expect(res).toEqual({ generated: false, reason: 'already-done' });
  });

  it('映射为 boss 的用户（老板娘）也收到推送', async () => {
    await persona.setEntry(
      { sub: 'op', username: 'op', type: 'access' },
      { userId: salesId, persona: 'boss' },
    );
    // 清幂等键重发一轮验证映射生效
    const key = industry.currentKey();
    await prisma.systemMeta.deleteMany({ where: { key: `industry.daily.done.${key}` } });
    await prisma.notification.deleteMany({ where: { kind: 'industry.daily' } });
    const res = await industry.runIfDue();
    expect(res.generated).toBe(true);
    const notified = await prisma.notification.findMany({
      where: { kind: 'industry.daily' },
      select: { userId: true },
    });
    expect(notified.map((n) => n.userId)).toContain(salesId);
  });

  it('开关：WG_INDUSTRY_DAILY=off 跳过', async () => {
    const prev = process.env.WG_INDUSTRY_DAILY;
    process.env.WG_INDUSTRY_DAILY = 'off';
    try {
      expect(await industry.runIfDue()).toEqual({ generated: false, reason: 'disabled' });
    } finally {
      if (prev === undefined) delete process.env.WG_INDUSTRY_DAILY;
      else process.env.WG_INDUSTRY_DAILY = prev;
    }
  });
});
