import type { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import { LEAD_EVENT_KIND } from '../src/modules/lead/lead.constants';
import { LeadLifecycleService } from '../src/modules/lead/lead-lifecycle.service';
import { SlaService } from '../src/modules/lead/sla.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { uniqueUsername } from './helpers/unique';
import { buildApp } from './setup';

/** 停掉测试 app 的定时任务：生命周期用例直调 service/端点，不赌定时器（P2 模式） */
function stopCronJobs(app: INestApplication): void {
  for (const job of app.get(SchedulerRegistry).getCronJobs().values()) void job.stop();
}

interface TokenUser {
  id: string;
  username: string;
  token: string;
}

describe('P3-04 阶段状态机＋流失权限流＋暂停接管（集成）', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let auth: AuthService;
  let sla: SlaService;
  let lifecycle: LeadLifecycleService;
  const password = 'S3cure-Passw0rd!';
  let leadSeq = 0;

  const mkUser = async (role: string): Promise<TokenUser> => {
    const username = uniqueUsername(`lc_${role}`);
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
    const user = await prisma.user.create({
      data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
    const res = await request(server).post('/api/v1/auth/login').send({ username, password });
    return { id: user.id, username, token: (res.body as { accessToken: string }).accessToken };
  };

  const mkLead = (ownerUserId: string | null, extra: Record<string, unknown> = {}) =>
    prisma.lead.create({
      data: {
        leadNo: `L-LC-${Date.now()}-${++leadSeq}`,
        sourceCategory: 'online',
        sourcePlatform: '抖音',
        ownerUserId,
        ...extra,
      },
    });

  const stage = (id: string, to: string, token: string, reason = '正常推进') =>
    request(server)
      .patch(`/api/v1/leads/${id}/stage`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stage: to, reason });

  beforeAll(async () => {
    app = await buildApp();
    stopCronJobs(app);
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    sla = app.get(SlaService);
    lifecycle = app.get(LeadLifecycleService);
    for (const code of ['boss', 'store_manager', 'sales_ops']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  describe('阶段状态机', () => {
    it('合法顺序推进 new→contacted→communicating→quoted→visit_booked→visit_done 全程事件留痕', async () => {
      const owner = await mkUser('sales_ops');
      const lead = await mkLead(owner.id);

      const path = ['contacted', 'communicating', 'quoted', 'visit_booked', 'visit_done'];
      for (const to of path) {
        const res = await stage(lead.id, to, owner.token);
        expect(res.status).toBe(200);
        expect((res.body as { stage: string }).stage).toBe(to);
      }

      const events = await prisma.leadEvent.findMany({
        where: { leadId: lead.id, kind: LEAD_EVENT_KIND.STAGE_CHANGED },
        orderBy: { occurredAt: 'asc' },
      });
      expect(events).toHaveLength(5);
      expect(events.map((e) => (e.content as { to: string }).to)).toEqual([
        'contacted',
        'communicating',
        'quoted',
        'visit_booked',
        'visit_done',
      ]);

      const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.stage).toBe('visit_done');
      expect(persisted.finalStatus).toBe('active');
    });

    it('非法迁移被拒 409 LEAD_INVALID_STATE（new→quoted）', async () => {
      const owner = await mkUser('sales_ops');
      const lead = await mkLead(owner.id);
      const res = await stage(lead.id, 'quoted', owner.token);
      expect(res.status).toBe(409);
      expect((res.body as { code: string }).code).toBe('LEAD_INVALID_STATE');
    });

    it('reason 缺失被拒 422', async () => {
      const owner = await mkUser('sales_ops');
      const lead = await mkLead(owner.id);
      const res = await request(server)
        .patch(`/api/v1/leads/${lead.id}/stage`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ stage: 'contacted' });
      // ZodValidationPipe 缺 reason → BadRequest（同 approval.spec 约定 [400,422]）
      expect([400, 422]).toContain(res.status);
      expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
    });

    it('进入 visit_booked 自动创建 Opportunity（懒创建，仅一次）', async () => {
      const owner = await mkUser('sales_ops');
      const lead = await mkLead(owner.id);
      await stage(lead.id, 'contacted', owner.token);
      await stage(lead.id, 'communicating', owner.token);
      await stage(lead.id, 'quoted', owner.token);
      await stage(lead.id, 'visit_booked', owner.token);

      const first = await prisma.opportunity.findUnique({ where: { leadId: lead.id } });
      expect(first).not.toBeNull();

      // 二次进入 visit_booked（visit_booked→visit_done→quoted→visit_booked）不重复建
      await stage(lead.id, 'visit_done', owner.token);
      await stage(lead.id, 'quoted', owner.token);
      await stage(lead.id, 'visit_booked', owner.token);
      const count = await prisma.opportunity.count({ where: { leadId: lead.id } });
      expect(count).toBe(1);
    });

    it('confirmWon 写 won/closedAt/金额原因；Opportunity 扩展字段可后补', async () => {
      const owner = await mkUser('sales_ops');
      const lead = await mkLead(owner.id);
      for (const to of ['contacted', 'communicating', 'quoted', 'visit_booked']) {
        await stage(lead.id, to, owner.token);
      }

      const won = await request(server)
        .post(`/api/v1/leads/${lead.id}/won`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          amountFen: 128800,
          reason: '客户确认到店成交',
          visitOriginalPlan: '原方案：标准车膜',
          visitFinalPlan: '最终方案：升级陶瓷膜',
          upsellReason: '到店后推荐升级',
          grossMarginImpact: '毛利提升约 8%',
        });
      expect(won.status).toBe(200);

      const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.finalStatus).toBe('won');
      expect(persisted.closedAt).not.toBeNull();
      expect(persisted.closedAmountFen).toBe(128800);
      expect(persisted.closeReason).toBe('客户确认到店成交');

      const opp = await prisma.opportunity.findUniqueOrThrow({ where: { leadId: lead.id } });
      expect(opp.visitOriginalPlan).toBe('原方案：标准车膜');
      expect(opp.visitFinalPlan).toBe('最终方案：升级陶瓷膜');
      expect(opp.upsellReason).toBe('到店后推荐升级');
      expect(opp.grossMarginImpact).toBe('毛利提升约 8%');
    });

    it('并发同迁移仅一次成功（条件 updateMany 防竞态）', async () => {
      const owner = await mkUser('sales_ops');
      const lead = await mkLead(owner.id);
      const [a, b] = await Promise.all([
        stage(lead.id, 'contacted', owner.token),
        stage(lead.id, 'contacted', owner.token),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.stage).toBe('contacted');
    });

    it('T5 前置状态不满足的条件迁移一律 409：终态后成交/无效/提议流失、重复重开', async () => {
      const owner = await mkUser('sales_ops');
      const boss = await mkUser('boss');

      // 成交后：再次成交 / 标记无效 / 提议流失 均被条件迁移挡下（finalStatus 已离开 active）
      const wonLead = await mkLead(owner.id, { finalStatus: 'won' });
      const reWon = await request(server)
        .post(`/api/v1/leads/${wonLead.id}/won`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ amountFen: 100, reason: '重复成交' });
      expect(reWon.status).toBe(409);
      expect((reWon.body as { code: string }).code).toBe('LEAD_INVALID_STATE');
      const invalidOnWon = await request(server)
        .post(`/api/v1/leads/${wonLead.id}/invalid`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: '误标' });
      expect(invalidOnWon.status).toBe(409);
      const churnOnWon = await request(server)
        .post(`/api/v1/leads/${wonLead.id}/churn-propose`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'price' });
      expect(churnOnWon.status).toBe(409);
      // 金额未被二次写覆盖
      const wonPersisted = await prisma.lead.findUniqueOrThrow({ where: { id: wonLead.id } });
      expect(wonPersisted.closedAmountFen).toBeNull();

      // 已无效：再次无效 409
      const invalidLead = await mkLead(owner.id, { finalStatus: 'invalid' });
      const reInvalid = await request(server)
        .post(`/api/v1/leads/${invalidLead.id}/invalid`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: '重复无效' });
      expect(reInvalid.status).toBe(409);

      // lost_pending（已提议）：重复提议 409，不落第二个审批项
      const pendingLead = await mkLead(owner.id, { finalStatus: 'lost_pending' });
      const rePropose = await request(server)
        .post(`/api/v1/leads/${pendingLead.id}/churn-propose`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'price' });
      expect(rePropose.status).toBe(409);

      // 非 lost：重开 409；lost 重开成功后重复重开 409
      const activeLead = await mkLead(owner.id, { finalStatus: 'active' });
      const reopenActive = await request(server)
        .post(`/api/v1/leads/${activeLead.id}/reopen`)
        .set('Authorization', `Bearer ${boss.token}`)
        .send({ reason: '无需重开' });
      expect(reopenActive.status).toBe(409);
      const lostLead = await mkLead(owner.id, { finalStatus: 'lost' });
      const firstReopen = await request(server)
        .post(`/api/v1/leads/${lostLead.id}/reopen`)
        .set('Authorization', `Bearer ${boss.token}`)
        .send({ reason: '客户回归' });
      expect(firstReopen.status).toBe(200);
      const secondReopen = await request(server)
        .post(`/api/v1/leads/${lostLead.id}/reopen`)
        .set('Authorization', `Bearer ${boss.token}`)
        .send({ reason: '重复重开' });
      expect(secondReopen.status).toBe(409);
      const reopenedEvents = await prisma.leadEvent.count({
        where: { leadId: lostLead.id, kind: LEAD_EVENT_KIND.REOPENED },
      });
      expect(reopenedEvents).toBe(1);
    });

    it('T5 流失决定回写幂等原子化：重复 applyChurnDecision 不双写 churn_decided 事件', async () => {
      const owner = await mkUser('sales_ops');
      const boss = await mkUser('boss');
      const lead = await mkLead(owner.id);
      const propose = await request(server)
        .post(`/api/v1/leads/${lead.id}/churn-propose`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'price' });
      const approvalId = (propose.body as { approvalId: string }).approvalId;

      // 并发语义表达：审批项已决定（approved），连续重放两次决定回写（模拟决定回调与对账 cron 撞车）
      await prisma.approvalItem.update({
        where: { id: approvalId },
        data: { status: 'approved', approverId: boss.id, decidedAt: new Date() },
      });
      await lifecycle.applyChurnDecision(approvalId, true);
      await lifecycle.applyChurnDecision(approvalId, true);

      const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.finalStatus).toBe('lost');
      const decidedEvents = await prisma.leadEvent.count({
        where: { leadId: lead.id, kind: LEAD_EVENT_KIND.CHURN_DECIDED },
      });
      expect(decidedEvents).toBe(1);
    });
  });

  describe('流失权限流', () => {
    it('负责人建议流失：reason 必填 → lost_pending + ApprovalItem(lead.churn)', async () => {
      const owner = await mkUser('sales_ops');
      const lead = await mkLead(owner.id);

      const res = await request(server)
        .post(`/api/v1/leads/${lead.id}/churn-propose`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'price', note: '客户嫌价格高' });
      expect(res.status).toBe(200);
      expect((res.body as { finalStatus: string }).finalStatus).toBe('lost_pending');
      const approvalId = (res.body as { approvalId: string }).approvalId;

      const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.finalStatus).toBe('lost_pending');
      expect(persisted.lostReason).toBe('price');

      const item = await prisma.approvalItem.findUnique({ where: { id: approvalId } });
      expect(item).not.toBeNull();
      expect(item!.type).toBe('lead.churn');
      expect((item!.payload as { leadId: string }).leadId).toBe(lead.id);
    });

    it('boss 批准 → lost；驳回 → 恢复原状态，均写 churn_decided 事件', async () => {
      const owner = await mkUser('sales_ops');
      const boss = await mkUser('boss');

      // 批准路径
      const leadA = await mkLead(owner.id);
      const proposeA = await request(server)
        .post(`/api/v1/leads/${leadA.id}/churn-propose`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'competitor' });
      const approvalIdA = (proposeA.body as { approvalId: string }).approvalId;
      const approve = await request(server)
        .post(`/api/v1/approvals/${approvalIdA}/approve`)
        .set('Authorization', `Bearer ${boss.token}`)
        .send({ confirmed: true });
      expect(approve.status).toBe(201);
      const lostLead = await prisma.lead.findUniqueOrThrow({ where: { id: leadA.id } });
      expect(lostLead.finalStatus).toBe('lost');
      expect(lostLead.closedAt).not.toBeNull();

      // 驳回路径
      const leadB = await mkLead(owner.id);
      const proposeB = await request(server)
        .post(`/api/v1/leads/${leadB.id}/churn-propose`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'unreachable' });
      const approvalIdB = (proposeB.body as { approvalId: string }).approvalId;
      const reject = await request(server)
        .post(`/api/v1/approvals/${approvalIdB}/reject`)
        .set('Authorization', `Bearer ${boss.token}`)
        .send({ confirmed: true, reason: '客户已回电，继续跟进' });
      expect(reject.status).toBe(201);
      const restored = await prisma.lead.findUniqueOrThrow({ where: { id: leadB.id } });
      expect(restored.finalStatus).toBe('active');
      expect(restored.lostReason).toBeNull();

      const decidedA = await prisma.leadEvent.findFirst({
        where: { leadId: leadA.id, kind: LEAD_EVENT_KIND.CHURN_DECIDED },
      });
      const decidedB = await prisma.leadEvent.findFirst({
        where: { leadId: leadB.id, kind: LEAD_EVENT_KIND.CHURN_DECIDED },
      });
      expect(decidedA).not.toBeNull();
      expect(decidedB).not.toBeNull();
    });

    it('非负责人（非 boss/店长）不得提议他人客资流失 403', async () => {
      const owner = await mkUser('sales_ops');
      const other = await mkUser('sales_ops');
      const lead = await mkLead(owner.id);

      const res = await request(server)
        .post(`/api/v1/leads/${lead.id}/churn-propose`)
        .set('Authorization', `Bearer ${other.token}`)
        .send({ reason: 'price' });
      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe('LEAD_NOT_OWNER');
    });

    it('沉默客资可提议流失：批准→lost；驳回→回 silence（14d 后人工确认路径）', async () => {
      const owner = await mkUser('sales_ops');
      const boss = await mkUser('boss');

      // 批准路径：silence → lost
      const leadA = await mkLead(owner.id, { finalStatus: 'silence', silenceStage: 'nurture' });
      const proposeA = await request(server)
        .post(`/api/v1/leads/${leadA.id}/churn-propose`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'unreachable' });
      expect(proposeA.status).toBe(200);
      const approvalIdA = (proposeA.body as { approvalId: string }).approvalId;
      await request(server)
        .post(`/api/v1/approvals/${approvalIdA}/approve`)
        .set('Authorization', `Bearer ${boss.token}`)
        .send({ confirmed: true });
      const lost = await prisma.lead.findUniqueOrThrow({ where: { id: leadA.id } });
      expect(lost.finalStatus).toBe('lost');
      expect(lost.closedAt).not.toBeNull();

      // 驳回路径：silence → lost_pending → 回 silence
      const leadB = await mkLead(owner.id, { finalStatus: 'silence', silenceStage: 'nurture' });
      const proposeB = await request(server)
        .post(`/api/v1/leads/${leadB.id}/churn-propose`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'need_gone' });
      const approvalIdB = (proposeB.body as { approvalId: string }).approvalId;
      await request(server)
        .post(`/api/v1/approvals/${approvalIdB}/reject`)
        .set('Authorization', `Bearer ${boss.token}`)
        .send({ confirmed: true, reason: '客户又回电，继续跟进' });
      const restored = await prisma.lead.findUniqueOrThrow({ where: { id: leadB.id } });
      expect(restored.finalStatus).toBe('silence');
      expect(restored.silenceStage).toBe('nurture');
      expect(restored.lostReason).toBeNull();
    });

    it('对账：审批已 decided 但 lead 仍 lost_pending → reconcileChurnDecisions 重放写回', async () => {
      const owner = await mkUser('sales_ops');
      const boss = await mkUser('boss');
      const lead = await mkLead(owner.id);
      const propose = await request(server)
        .post(`/api/v1/leads/${lead.id}/churn-propose`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'price' });
      const approvalId = (propose.body as { approvalId: string }).approvalId;

      // 模拟决定写回失败：直接把审批项置为 approved（不走 approve 端点，handler 未触发）
      await prisma.approvalItem.update({
        where: { id: approvalId },
        data: { status: 'approved', approverId: boss.id, decidedAt: new Date() },
      });
      let persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.finalStatus).toBe('lost_pending'); // 悬空态

      const replayed = await lifecycle.reconcileChurnDecisions();
      expect(replayed).toBeGreaterThanOrEqual(1);

      persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.finalStatus).toBe('lost');
    });

    it('reopen 仅 boss/store_manager，回原 owner，原流失事件保留不删', async () => {
      const owner = await mkUser('sales_ops');
      const boss = await mkUser('boss');
      const lead = await mkLead(owner.id);

      const propose = await request(server)
        .post(`/api/v1/leads/${lead.id}/churn-propose`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'need_gone' });
      const approvalId = (propose.body as { approvalId: string }).approvalId;
      await request(server)
        .post(`/api/v1/approvals/${approvalId}/approve`)
        .set('Authorization', `Bearer ${boss.token}`)
        .send({ confirmed: true });

      // sales_ops 重开被拒
      const denied = await request(server)
        .post(`/api/v1/leads/${lead.id}/reopen`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: '客户重新联系' });
      expect(denied.status).toBe(403);

      const churnEventsBefore = await prisma.leadEvent.count({
        where: { leadId: lead.id, kind: { in: ['churn_proposed', 'churn_decided'] } },
      });

      const reopened = await request(server)
        .post(`/api/v1/leads/${lead.id}/reopen`)
        .set('Authorization', `Bearer ${boss.token}`)
        .send({ reason: '客户重新联系' });
      expect(reopened.status).toBe(200);

      const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.finalStatus).toBe('active');
      expect(persisted.ownerUserId).toBe(owner.id); // 回原 owner（从未清除）

      // 原流失事件保留 + reopened 新增
      const churnEventsAfter = await prisma.leadEvent.count({
        where: { leadId: lead.id, kind: { in: ['churn_proposed', 'churn_decided'] } },
      });
      expect(churnEventsAfter).toBe(churnEventsBefore);
      const reopenedEvt = await prisma.leadEvent.findFirst({
        where: { leadId: lead.id, kind: LEAD_EVENT_KIND.REOPENED },
      });
      expect(reopenedEvt).not.toBeNull();
    });
  });

  describe('暂停与接管', () => {
    it('pause/resume 写 pausedAt 与事件；暂停期 SLA cron 不产生事件', async () => {
      const boss = await mkUser('boss');
      const owner = await mkUser('sales_ops');
      const lead = await mkLead(owner.id, {
        receivedAt: new Date('2026-08-14T09:00:00'),
        stage: 'new',
        firstContactAttemptAt: null,
      });

      const pause = await request(server)
        .post(`/api/v1/leads/${lead.id}/pause`)
        .set('Authorization', `Bearer ${boss.token}`)
        .send({ reason: '客户出差，暂缓跟进' });
      expect(pause.status).toBe(200);
      let persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.pausedAt).not.toBeNull();

      // 暂停期 SLA 扫描不产生事件
      await sla.tick(new Date('2026-08-14T09:30:00'));
      const slaEvents = await prisma.leadEvent.findMany({
        where: { leadId: lead.id, kind: { in: ['sla_remind', 'sla_breach', 'sla_escalate'] } },
      });
      expect(slaEvents).toHaveLength(0);

      const resume = await request(server)
        .post(`/api/v1/leads/${lead.id}/resume`)
        .set('Authorization', `Bearer ${boss.token}`)
        .send({});
      expect(resume.status).toBe(200);
      persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.pausedAt).toBeNull();

      const pausedEvt = await prisma.leadEvent.findFirst({
        where: { leadId: lead.id, kind: LEAD_EVENT_KIND.PAUSED },
      });
      const resumedEvt = await prisma.leadEvent.findFirst({
        where: { leadId: lead.id, kind: LEAD_EVENT_KIND.RESUMED },
      });
      expect(pausedEvt).not.toBeNull();
      expect(resumedEvt).not.toBeNull();
    });

    it('takeover 改派自己并写 Opportunity.takeover 与原因/证据/下次动作三要素', async () => {
      const boss = await mkUser('boss');
      const owner = await mkUser('sales_ops');
      const lead = await mkLead(owner.id);

      const res = await request(server)
        .post(`/api/v1/leads/${lead.id}/takeover`)
        .set('Authorization', `Bearer ${boss.token}`)
        .send({ reason: '负责人离职', evidence: '微信记录截图', nextAction: '本周内联系客户' });
      expect(res.status).toBe(200);

      const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.ownerUserId).toBe(boss.id);

      const opp = await prisma.opportunity.findUnique({ where: { leadId: lead.id } });
      expect(opp).not.toBeNull();
      expect(opp!.takeover).toBe(true);
      expect(opp!.takeoverReason).toBe('负责人离职');

      const evt = await prisma.leadEvent.findFirst({
        where: { leadId: lead.id, kind: LEAD_EVENT_KIND.TAKEOVER },
      });
      expect(evt).not.toBeNull();
      const content = evt!.content as {
        reason: string;
        evidence: string;
        nextAction: string;
      };
      expect(content.reason).toBe('负责人离职');
      expect(content.evidence).toBe('微信记录截图');
      expect(content.nextAction).toBe('本周内联系客户');
    });

    it('阶段迁移按 sla.stage.deadlines 写 dueAt', async () => {
      const owner = await mkUser('sales_ops');
      const lead = await mkLead(owner.id);
      await prisma.systemMeta.upsert({
        where: { key: 'sla.stage.deadlines' },
        create: { key: 'sla.stage.deadlines', value: '{"communicating":3}' },
        update: { value: '{"communicating":3}' },
      });

      await stage(lead.id, 'contacted', owner.token);
      await stage(lead.id, 'communicating', owner.token);

      const persisted = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(persisted.dueAt).not.toBeNull();
      const expected = Date.now() + 3 * 24 * 60 * 60 * 1000;
      expect(Math.abs(persisted.dueAt!.getTime() - expected)).toBeLessThan(60_000);
    });
  });
});
