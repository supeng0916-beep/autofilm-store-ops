import { existsSync } from 'node:fs';

import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../src/modules/auth/auth.service';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import type {
  GatewayRunResult,
  OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';
import { scanForLeaks } from '../src/modules/ai-dispatch/masker';
import { AssignService, ASSIGN_META_KEYS } from '../src/modules/lead/assign.service';
import { EmbeddingService } from '../src/modules/knowledge/embedding.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { uniqueUsername } from './helpers/unique';
import { buildApp } from './setup';

// 本套件按生产口径跑 RAG 阈值（setupFile 的 0 仅供其余套件）：
// 阈值 0 时向量 top-N 对任何查询都返回结果，miss 断言将依赖 AI 提交恰好失败才走
// 拒绝兜底（隐性耦合，曾随 ai-cost 清理当日任务而翻转）；0.3 下正交 one-hot 相似度 0
// 被确定性过滤 → 无关查询稳定走「无法确定，需人工核实」（A05）
vi.hoisted(() => {
  process.env.WG_RAG_MIN_SIMILARITY = '0.3';
});

/** P6-01 业务闭环回放（任务书 §7）：合成数据完整回放
 * 渠道派发 → 客资导入/去重 → 分配/SLA → 低打扰触达草稿 → 分类/摘要（建议态）→
 * 知识检索（带来源）→ 预约（冲突+审批+指定技师确认）→ 施工/质检/交付 → 案例回流 → 回访留痕。
 * 全程零人工修补；幂等断言：重复导入/重复点击/重试不产生重复业务结果（test ③）。
 * RAG 检索用确定性 one-hot 嵌入（无外部 API）：同文本=相似度1、异文本=0。
 * 阈值取 0.5：库中历史真实稠密向量与 one-hot 的点积约 ±0.03（必被排除），
 * 使「命中带来源/无关拒绝」双路径可确定断言（A05）。 */
process.env.WG_RAG_MIN_SIMILARITY = '0.5';

class FakeReplayGateway implements OpenClawGateway {
  submitted: SubmitTaskRequest[] = [];

  submit(req: SubmitTaskRequest): Promise<GatewayRunResult> {
    this.submitted.push(req);
    let output: GatewayRunResult['output'];
    if (req.taskType === 'lead.summary') {
      output = {
        summary: '客户关注隔热膜与车衣，意向高，已到店成交。',
        concerns: ['价格预算'],
        questionsToAsk: ['提车时间？'],
        nextAction: '安排施工',
      };
    } else if (req.taskType === 'lead.classify') {
      output = {
        level: 'high',
        confidence: 0.9,
        evidence: ['明确车型', '主动问价'],
        missingInfo: ['到店时间'],
        nextAction: '邀约到店',
      };
    } else if (req.taskType === 'knowledge.search') {
      output = {
        answer: 'DM04 前挡膜透光率 70%，质保 8 年（依据知识库价目手册）。',
        citations: [
          {
            title: '演示品牌 DM04 前挡膜',
            kind: 'product',
            source: '演示品牌官方价目手册（合成）',
            version: 1,
          },
        ],
        confidence: 'high',
      };
    } else {
      output = {
        message: '您好，看到您关注演示品牌隔热膜，方便加微信发您实车案例吗？',
        notes: '低打扰：不报价，先发案例。',
      };
    }
    return Promise.resolve({ status: 'done', output, model: 'fake' });
  }

  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** 确定性嵌入（duck-type 覆盖 EmbeddingService）：djb2 哈希 → one-hot（1536 维）。
 * 同文本同向量（相似度 1），异文本正交（相似度 0）。 */
class OneHotEmbedding {
  isConfigured(): boolean {
    return true;
  }

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(
      texts.map((t) => {
        const vec = new Array<number>(1536).fill(0);
        let h = 5381;
        for (const ch of t) h = ((h * 33 + ch.codePointAt(0)!) >>> 0) % 1536;
        vec[h] = 1;
        return vec;
      }),
    );
  }
}

function stopCronJobs(app: INestApplication): void {
  for (const job of app.get(SchedulerRegistry).getCronJobs().values()) void job.stop();
}

interface TokenUser {
  id: string;
  username: string;
  token: string;
}

let phoneSeq = 0;
/** 合成电话（S16）：138/139 段 + 时间戳 + 序号，跨测试运行唯一，零真实数据 */
function syntheticPhone(prefix = '138'): string {
  return `${prefix}${String(Date.now()).slice(-6)}${String(phoneSeq++).padStart(2, '0')}`;
}

function dispatchText(phone: string, dispatchNo: string, sourceInfo = '抖音私信'): string {
  return [
    `派发NO：${dispatchNo}`,
    '门店：AutoFilm Demo',
    '日期：2026-08-17 10:20',
    `信息来源：${sourceInfo}`,
    `电话：${phone}`,
    '车型：理想L9',
    '需求：DM04隔热膜+车衣',
  ].join('\n');
}

const png1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('P6-01 业务闭环回放（任务书 §7 合成版）', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let auth: AuthService;
  let gateway: FakeReplayGateway;
  let boss: TokenUser;
  let manager: TokenUser;
  let salesA: TokenUser;
  let salesB: TokenUser;
  let recorder: TokenUser;
  const password = 'S3cure-Passw0rd!';
  const tag = Math.random().toString(36).slice(2, 8);
  /** 预约时段相对基准（当前+30 天）：2026-08-28 起后端拒绝过去时间 */
  const relBase = new Date(Date.now() + 30 * 24 * 3600 * 1000);

  const mkUser = async (role: string): Promise<TokenUser> => {
    const username = uniqueUsername(`p6rp_${role}`);
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
    const user = await prisma.user.create({
      data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
    const res = await request(server).post('/api/v1/auth/login').send({ username, password });
    return { id: user.id, username, token: (res.body as { accessToken: string }).accessToken };
  };

  const api = (method: 'get' | 'post' | 'patch', url: string, token: string) =>
    request(server)[method](url).set('Authorization', `Bearer ${token}`);

  const importDispatch = async (rawTexts: string[], token: string) => {
    const res = await api('post', '/api/v1/leads/import/dispatch', token).send({ rawTexts });
    expect(res.status).toBe(200);
    return res.body as { batchId: string; created: number; dupCount: number };
  };

  const leadByDispatchNo = (no: string) =>
    prisma.lead.findFirst({ where: { upstreamDispatchNo: no } });

  const eventKinds = async (leadId: string): Promise<string[]> => {
    const events = await prisma.leadEvent.findMany({
      where: { leadId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    return events.map((e) => e.kind);
  };

  /** 建预约并店长审批确认（时段按序号错开防自冲突） */
  let slotSeq = 0;
  const confirmedAppointment = async (extra: Record<string, unknown> = {}) => {
    slotSeq += 1;
    const day = 20 + slotSeq;
    const created = await api('post', '/api/v1/appointments', salesA.token)
      .send({
        customerId: `cust-${tag}-${slotSeq}`,
        serviceItem: `DM04 隔热膜-${tag}`,
        businessType: 'window_film',
        workbench: `P6RP${tag}-${slotSeq}`,
        technicianName: '演示技师 C',
        startAt: new Date(
          Date.UTC(relBase.getUTCFullYear(), relBase.getUTCMonth(), relBase.getUTCDate() + day, 2),
        ).toISOString(),
        endAt: new Date(
          Date.UTC(relBase.getUTCFullYear(), relBase.getUTCMonth(), relBase.getUTCDate() + day, 5),
        ).toISOString(),
        ...extra,
      })
      .expect(201);
    const apptId = (created.body as { appointment: { id: string } }).appointment.id;
    const list = await api('get', '/api/v1/approvals?status=pending', manager.token).expect(200);
    const item = (
      list.body as Array<{ id: string; type: string; payload: { appointmentId?: string } }>
    ).find((a) => a.type === 'm07.schedule.confirm' && a.payload.appointmentId === apptId);
    expect(item).toBeDefined();
    await api('post', `/api/v1/approvals/${item!.id}/approve`, manager.token)
      .send({ confirmed: true, opinion: '回放排期确认' })
      .expect(201);
    return { apptId, approvalId: item!.id };
  };

  beforeAll(async () => {
    gateway = new FakeReplayGateway();
    app = await buildApp(gateway, [{ token: EmbeddingService, value: new OneHotEmbedding() }]);
    stopCronJobs(app);
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    // 同日重跑残留防御（2026-09-01 V1.5 批次4 加入）：appointment/p6-replay/p6-security/
    // work-order 多套件共用固定技师名+相对基准日造预约，afterAll 清理不完整时同日第二轮
    // 全量互相 409。测试库这三表只有测试数据，全清彻底且安全。
    await prisma.workOrder.deleteMany({});
    await prisma.appointmentTechnicianChange.deleteMany({});
    await prisma.appointment.deleteMany({});
    auth = app.get(AuthService);
    void app.get(AssignService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder', 'admin']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    boss = await mkUser('boss');
    manager = await mkUser('store_manager');
    salesA = await mkUser('sales_ops');
    salesB = await mkUser('sales_ops');
    recorder = await mkUser('recorder');

    // 分配池：线上池 salesA/salesB 轮询；游标归零
    await prisma.systemMeta.upsert({
      where: { key: ASSIGN_META_KEYS.onlinePool },
      create: {
        key: ASSIGN_META_KEYS.onlinePool,
        value: JSON.stringify([salesA.username, salesB.username]),
      },
      update: { value: JSON.stringify([salesA.username, salesB.username]) },
    });
    await prisma.systemMeta.upsert({
      where: { key: ASSIGN_META_KEYS.cursor },
      create: { key: ASSIGN_META_KEYS.cursor, value: '0' },
      update: { value: '0' },
    });
  });

  afterAll(async () => {
    await prisma.workOrder.deleteMany({ where: { workbench: { contains: tag } } });
    await prisma.appointment.deleteMany({ where: { workbench: { contains: tag } } });
    await prisma.knowledgeItem.deleteMany({ where: { key: { contains: tag } } });
    await app.close();
  });

  beforeEach(() => {
    gateway.submitted = [];
  });

  it('① 成交主链：派发→分配→低打扰草稿→分级确认→知识报价→成交→预约→施工→交付→案例回流→回访', async () => {
    // ── 1. 渠道派发 → 客资（唯一ID/来源/时间戳）──
    const phone = syntheticPhone('139');
    const dispatchNo = `D-P6RP-${Date.now()}`;
    const imported = await importDispatch([dispatchText(phone, dispatchNo)], boss.token);
    expect(imported.created).toBe(1);
    const lead = await leadByDispatchNo(dispatchNo);
    expect(lead).not.toBeNull();
    const leadId = lead!.id;
    expect(lead!.sourcePlatform).toBe('抖音');
    expect(lead!.upstreamDispatchAt).not.toBeNull();
    expect(lead!.receivedAt).not.toBeNull();

    // ── 2. 自动分配（线上池）→ 负责人 + assignedAt ──
    expect([salesA.id, salesB.id]).toContain(lead!.ownerUserId);
    expect(lead!.assignedAt).not.toBeNull();
    const owner = lead!.ownerUserId === salesA.id ? salesA : salesB;

    // ── 3. 低打扰首触：先出草稿（建议态）再人工联系留痕 ──
    const draft = await api('post', `/api/v1/leads/${leadId}/drafts`, owner.token)
      .send({ goal: '首次触达：加微信发案例' })
      .expect(200);
    const draftTaskId = (draft.body as { taskId: string }).taskId;
    await api('post', `/api/v1/leads/${leadId}/drafts/${draftTaskId}/copy`, owner.token).expect(
      200,
    );
    // A10「已复制」≠「已发送」：无发送态流转
    const afterCopy = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(afterCopy.lastFollowUpResult).toBeNull();
    await api('post', `/api/v1/leads/${leadId}/contact-attempt`, owner.token).expect(200);

    // ── 4. 客户回复 → 自动分级建议 → 人工确认（建议态隔离：确认前 intentLevel=pending）──
    await api('post', `/api/v1/leads/${leadId}/customer-reply`, owner.token).expect(200);
    const pendingLead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(pendingLead.intentLevel).toBe('pending');
    const proposals = await api(
      'get',
      `/api/v1/leads/${leadId}/intent-proposals`,
      owner.token,
    ).expect(200);
    const proposal = (proposals.body as { proposal: { taskId: string; level: string } | null })
      .proposal;
    expect(proposal).not.toBeNull();
    await api('post', `/api/v1/leads/${leadId}/intent-confirm`, owner.token)
      .send({ taskId: proposal!.taskId })
      .expect(200);
    const classified = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(classified.intentLevel).toBe('high');

    // ── 4.5 沟通跟进留痕（结果/下一步/下次时间——每轮跟进的完整记录）──
    await api('post', `/api/v1/leads/${leadId}/follow-up`, owner.token)
      .send({
        result: '客户微信已回复，明确要 DM04+车衣',
        nextAction: '发送实车案例并邀约到店',
        nextFollowUpAt: '2026-08-18T02:00:00.000Z',
      })
      .expect(200);

    // ── 5. AI 摘要（建议态，不写业务字段；2026-08-26 起状态视图 {status, summary}）──
    const summary = await api('get', `/api/v1/leads/${leadId}/ai-summary`, owner.token).expect(200);
    expect(
      (summary.body as { summary: { summary: string } | null }).summary!.summary.length,
    ).toBeGreaterThan(0);

    // ── 6. 知识检索：报价/质保带来源；无来源拒绝确定性回答（A05）──
    // 店长经 API 建知识并生效（真实业务路径：生效触发向量化索引）
    const dm04Content = `演示品牌DM04前挡膜，透光率70%，质保8年，官方指导价区间见价目表（回放${tag}）`;
    const createdItem = await api('post', '/api/v1/knowledge', manager.token)
      .send({
        kind: 'product',
        key: `p6rp-dm04-${tag}`,
        title: '演示品牌 DM04 前挡膜',
        content: dm04Content,
        source: '演示品牌官方价目手册（合成）',
        licensed: true,
      })
      .expect(201);
    const itemId = (createdItem.body as { id: string }).id;
    await api('post', `/api/v1/knowledge/${itemId}/activate`, manager.token).expect(200);
    // 生效后向量化为异步：轮询等待分块落库（本地 one-hot 嵌入，毫秒级）
    await vi.waitFor(async () => {
      const rows = await prisma.knowledgeEmbedding.count({ where: { itemId } });
      expect(rows).toBeGreaterThan(0);
    });

    // 命中：查询=已生效内容 → 检索带来源引用
    const hit = await api('post', '/api/v1/knowledge/search', owner.token)
      .send({ query: dm04Content })
      .expect(200);
    const hitBody = hit.body as {
      answer: string;
      results: Array<{ source: string | null }>;
    };
    expect(hitBody.answer).not.toBe('无法确定，需人工核实');
    expect(hitBody.results.some((r) => r.source === '演示品牌官方价目手册（合成）')).toBe(true);
    // 无关查询（知识库无此内容）→ 拒绝确定性回答（A05）
    const miss = await api('post', '/api/v1/knowledge/search', owner.token)
      .send({ query: '虚构品牌ZZ工艺参数-未收录' })
      .expect(200);
    const missBody = miss.body as { answer: string; confidence: string };
    expect(missBody.answer).toBe('无法确定，需人工核实');
    expect(missBody.confidence).toBe('uncertain');

    // ── 7. 邀约到店 → 成交（人工结论，AI 不判定）──
    for (const to of ['contacted', 'communicating', 'visit_booked']) {
      await api('patch', `/api/v1/leads/${leadId}/stage`, owner.token)
        .send({ stage: to, reason: '回放推进' })
        .expect(200);
    }
    await api('post', `/api/v1/leads/${leadId}/won`, owner.token)
      .send({ amountFen: 1580000, reason: '到店成交 DM04+车衣' })
      .expect(200);
    const wonLead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(wonLead.finalStatus).toBe('won');
    expect(wonLead.firstContactAttemptAt).not.toBeNull();
    expect(wonLead.firstCustomerReplyAt).not.toBeNull();

    // ── 8. 预约：冲突拦截 → 审批确认 → 指定技师替换客户确认后生效 ──
    // 相对基准 +28 天（后端拒绝过去时间，固定日期会过期）
    const slotA = {
      startAt: new Date(
        Date.UTC(relBase.getUTCFullYear(), relBase.getUTCMonth(), relBase.getUTCDate() + 28, 2),
      ).toISOString(),
      endAt: new Date(
        Date.UTC(relBase.getUTCFullYear(), relBase.getUTCMonth(), relBase.getUTCDate() + 28, 5),
      ).toISOString(),
    };
    // 同工位同时段先建一条（冲突对照），再建正式预约
    await api('post', '/api/v1/appointments', salesA.token)
      .send({
        customerId: `cust-${tag}-occupy`,
        serviceItem: '占位',
        businessType: 'car_cover',
        workbench: `P6RPX${tag}`,
        ...slotA,
      })
      .expect(201);
    const conflict = await api('post', '/api/v1/appointments', salesA.token)
      .send({
        customerId: `cust-${tag}-main`,
        leadId,
        serviceItem: 'DM04+车衣施工',
        businessType: 'car_cover',
        workbench: `P6RPX${tag}`,
        ...slotA,
      })
      .expect(409);
    expect((conflict.body as { code: string }).code).toBe('APPOINTMENT_CONFLICT');

    const created = await api('post', '/api/v1/appointments', salesA.token)
      .send({
        customerId: `cust-${tag}-main`,
        leadId,
        serviceItem: 'DM04+车衣施工',
        businessType: 'car_cover',
        workbench: `P6RPX${tag}`,
        technicianName: '演示技师 B',
        technicianDesignated: true,
        startAt: new Date(
          Date.UTC(relBase.getUTCFullYear(), relBase.getUTCMonth(), relBase.getUTCDate() + 28, 6),
        ).toISOString(),
        endAt: new Date(
          Date.UTC(relBase.getUTCFullYear(), relBase.getUTCMonth(), relBase.getUTCDate() + 28, 9),
        ).toISOString(),
      })
      .expect(201);
    const apptId = (created.body as { appointment: { id: string } }).appointment.id;

    const changeRes = await api(
      'post',
      `/api/v1/appointments/${apptId}/technician-change`,
      salesA.token,
    )
      .send({ toName: '演示技师 C', reason: '演示技师 B调休' })
      .expect(201);
    const changeId = (changeRes.body as { id: string }).id;
    // 未客户确认：技师不变
    const beforeConfirm = await api('get', `/api/v1/appointments/${apptId}`, salesA.token).expect(
      200,
    );
    expect((beforeConfirm.body as { technicianName: string }).technicianName).toBe('演示技师 B');
    await api(
      'post',
      `/api/v1/appointments/${apptId}/technician-change/${changeId}/confirm`,
      salesA.token,
    )
      .send({ confirmMethod: 'wechat', note: '客户微信确认' })
      .expect(200);

    const list = await api('get', '/api/v1/approvals?status=pending', manager.token).expect(200);
    const item = (
      list.body as Array<{ id: string; type: string; payload: { appointmentId?: string } }>
    ).find((a) => a.type === 'm07.schedule.confirm' && a.payload.appointmentId === apptId);
    expect(item).toBeDefined();
    await api('post', `/api/v1/approvals/${item!.id}/approve`, manager.token)
      .send({ confirmed: true, opinion: '回放排期确认' })
      .expect(201);
    const appt = await api('get', `/api/v1/appointments/${apptId}`, salesA.token).expect(200);
    const apptBody = appt.body as {
      status: string;
      managerConfirmed: boolean;
      technicianName: string;
    };
    expect(apptBody.status).toBe('confirmed');
    expect(apptBody.managerConfirmed).toBe(true);
    expect(apptBody.technicianName).toBe('演示技师 C');

    // ── 9. 施工单全状态机（记录员录入，店长复检/交付；补录+照片+异常+返工）──
    const woRes = await api('post', '/api/v1/work-orders', recorder.token)
      .send({ appointmentId: apptId })
      .expect(201);
    const wo = woRes.body as { id: string; orderNo: string; stage: string; leadId: string | null };
    expect(wo.orderNo).toMatch(/^W-\d{8}-\d{4}$/);
    expect(wo.leadId).toBe(leadId);
    const woId = wo.id;

    await api('post', `/api/v1/work-orders/${woId}/start`, recorder.token).expect(200);
    const photoRes = await api('post', `/api/v1/work-orders/${woId}/photos`, recorder.token)
      .field('note', '施工前')
      .attach('file', png1x1, { filename: '前挡.png', contentType: 'image/png' })
      .expect(200);
    const photoPath = (photoRes.body as { photos: Array<{ path: string }> }).photos[0]?.path;
    expect(photoPath).toBeTruthy();
    expect(existsSync(photoPath)).toBe(true);
    await api('post', `/api/v1/work-orders/${woId}/abnormal`, recorder.token)
      .send({ description: '车门原划痕已拍照确认' })
      .expect(200);

    // 自检带原时间：受控补录留痕
    const occurredAt = new Date(Date.UTC(2026, 8, 28, 8)).toISOString();
    const selfRes = await api('post', `/api/v1/work-orders/${woId}/self-check`, recorder.token)
      .send({ note: '技师自检通过', occurredAt })
      .expect(200);
    expect((selfRes.body as { backfilled: boolean }).backfilled).toBe(true);

    // 复检发现尘点 → 返工 → 重走质检 → 交付（AI 无判定合格路径）
    await api('post', `/api/v1/work-orders/${woId}/recheck`, manager.token)
      .send({ note: '复检发现右后窗尘点' })
      .expect(200);
    const reworkRes = await api('post', `/api/v1/work-orders/${woId}/rework`, manager.token)
      .send({ reason: '右后窗膜面尘点返工' })
      .expect(200);
    expect((reworkRes.body as { stage: string }).stage).toBe('in_progress');
    await api('post', `/api/v1/work-orders/${woId}/self-check`, recorder.token)
      .send({ note: '返工后自检通过' })
      .expect(200);

    // 养护说明：知识确定性草稿（带来源）+ 人工确认
    await prisma.knowledgeItem.create({
      data: {
        kind: 'warranty',
        key: `p6rp-warranty-${tag}`,
        title: '隔热膜质保政策',
        content: '施工后 7 天不洗车，30 天不贴吸附件，质保 8 年',
        source: '演示品牌官方质保手册（合成）',
        status: 'active',
        licensed: true,
        createdBy: manager.id,
      },
    });
    const careDraft = await api(
      'get',
      `/api/v1/work-orders/${woId}/care-notes/draft`,
      recorder.token,
    ).expect(200);
    const care = (careDraft.body as { careNotes: { draft: string; sources: unknown[] } }).careNotes;
    expect(care.sources.length).toBeGreaterThan(0);
    await api('post', `/api/v1/work-orders/${woId}/care-notes/confirm`, manager.token)
      .send({ content: '按官方质保口径交付' })
      .expect(200);

    await api('post', `/api/v1/work-orders/${woId}/recheck`, manager.token)
      .send({ note: '返工后复检合格' })
      .expect(200);
    const deliverRes = await api('post', `/api/v1/work-orders/${woId}/deliver`, manager.token)
      .send({ note: '客户验收交付' })
      .expect(200);
    expect((deliverRes.body as { stage: string; deliveredBy: string }).stage).toBe('delivered');
    expect((deliverRes.body as { deliveredBy: string }).deliveredBy).toBe(manager.id);

    // ── 10. 案例回流：授权 → 知识库案例草稿（licensed + 来源=施工单号）──
    const caseRes = await api('post', `/api/v1/work-orders/${woId}/case-request`, manager.token)
      .send({ authorized: true, method: 'wechat', note: '客户同意展示' })
      .expect(200);
    expect((caseRes.body as { caseRequest: { authorized: boolean } }).caseRequest.authorized).toBe(
      true,
    );
    const caseItem = await prisma.knowledgeItem.findFirst({
      where: { kind: 'case', key: `case-${wo.orderNo.toLowerCase()}` },
    });
    expect(caseItem).not.toBeNull();
    expect(caseItem!.licensed).toBe(true);
    expect(caseItem!.source).toBe(`work_order:${wo.orderNo}`);

    // ── 11. 交付后回访边界：M09 售后回访/转介绍为 V1 外（设计规格 §9），
    // won 客资不再接受跟进记录——系统正确拒绝（409）而非静默误写；列入已知限制 ──
    const postSaleFollowUp = await api('post', `/api/v1/leads/${leadId}/follow-up`, owner.token)
      .send({
        result: '交付后回访',
        nextAction: '30天后提醒复查',
        nextFollowUpAt: '2026-09-17T02:00:00.000Z',
      })
      .expect(409);
    expect((postSaleFollowUp.body as { code: string }).code).toBe('LEAD_INVALID_STATE');

    // ── 12. 全链横向断言：结论字段 + 事件链 + 审计 + AI 脱敏 ──
    const finalLead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(finalLead.finalStatus).toBe('won');
    expect(finalLead.closedAt).not.toBeNull();
    const kinds = await eventKinds(leadId);
    for (const k of [
      'dispatch_parsed',
      'assigned',
      'draft_copied',
      'intent_confirmed',
      'stage_changed',
      'won',
      'followup_recorded',
    ]) {
      expect(kinds).toContain(k);
    }
    // 事件时间线有序（非降序）
    const events = await prisma.leadEvent.findMany({
      where: { leadId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    for (let i = 1; i < events.length; i++) {
      expect(events[i].occurredAt.getTime()).toBeGreaterThanOrEqual(
        events[i - 1].occurredAt.getTime(),
      );
    }
    // 审计：客资域 + 预约确认 + 施工交付均留痕
    const leadAudit = await prisma.auditLog.findMany({
      where: { objectType: 'lead', objectId: leadId },
    });
    expect(leadAudit.map((a) => a.action)).toEqual(expect.arrayContaining(['lead.won']));
    const apptAudit = await prisma.auditLog.findFirst({
      where: { objectType: 'appointment', objectId: apptId, action: 'appointment.confirmed' },
    });
    expect(apptAudit).not.toBeNull();
    // AI 上下文零泄漏（A04）：本链全部提交载荷过泄漏扫描
    expect(gateway.submitted.length).toBeGreaterThan(0);
    for (const s of gateway.submitted) {
      expect(scanForLeaks(s)).toEqual([]);
    }
    // 每类 AI 输出均为建议/草稿态：本链 skill 集合只含整理/检索/草拟类
    const types = new Set(gateway.submitted.map((s) => s.taskType));
    expect(
      [...types].every((t) =>
        ['lead.summary', 'lead.classify', 'sales.draft_message', 'knowledge.search'].includes(t),
      ),
    ).toBe(true);
  });

  it('② 流失链：分配→触达→沉默口径人工确认流失（老板批准，AI 不判最终流失）', async () => {
    const phone = syntheticPhone('138');
    const dispatchNo = `D-P6RP-${Date.now()}-lost`;
    await importDispatch([dispatchText(phone, dispatchNo, '小红书私信')], boss.token);
    const lead = await leadByDispatchNo(dispatchNo);
    expect(lead).not.toBeNull();
    const owner = lead!.ownerUserId === salesA.id ? salesA : salesB;

    await api('post', `/api/v1/leads/${lead!.id}/contact-attempt`, owner.token).expect(200);
    await api('patch', `/api/v1/leads/${lead!.id}/stage`, owner.token)
      .send({ stage: 'contacted', reason: '已触达' })
      .expect(200);

    const propose = await api('post', `/api/v1/leads/${lead!.id}/churn-propose`, owner.token)
      .send({ reason: 'unreachable', note: '多次触达无回复' })
      .expect(200);
    const approvalId = (propose.body as { approvalId: string }).approvalId;
    expect((propose.body as { finalStatus: string }).finalStatus).toBe('lost_pending');

    await api('post', `/api/v1/approvals/${approvalId}/approve`, boss.token)
      .send({ confirmed: true })
      .expect(201);
    const lost = await prisma.lead.findUniqueOrThrow({ where: { id: lead!.id } });
    expect(lost.finalStatus).toBe('lost');
    expect(lost.closedAt).not.toBeNull();
    expect(await eventKinds(lead!.id)).toEqual(
      expect.arrayContaining(['dispatch_parsed', 'assigned', 'churn_proposed', 'churn_decided']),
    );
  });

  it('③ 幂等与重复操作：重复导入/重复点击/重试不产生重复业务结果', async () => {
    // 3.1 同派发原文重试导入：dup 挂链，活跃主客资仍唯一
    const phone = syntheticPhone('139');
    const dispatchNo = `D-P6RP-${Date.now()}-retry`;
    const raw = dispatchText(phone, dispatchNo);
    await importDispatch([raw], boss.token);
    const retry = await importDispatch([raw], boss.token);
    expect(retry.created).toBe(1);
    expect(retry.dupCount).toBe(1);
    const activePrimary = await prisma.lead.findFirst({
      where: { phone, dupOfLeadId: null, finalStatus: 'active' },
    });
    expect(activePrimary).not.toBeNull();
    const activeCount = await prisma.lead.count({
      where: { phone, dupOfLeadId: null, finalStatus: 'active' },
    });
    expect(activeCount).toBe(1);

    // 3.2 重复点击：重复审批决定 / 重复取消 / 重复阶段推进 均 409 且无二次副作用
    // （confirmedAppointment 内已 approve 成功 201，此处重复决定应被拦）
    const { apptId, approvalId } = await confirmedAppointment({ workbench: `P6RPI${tag}-1` });
    const again = await api('post', `/api/v1/approvals/${approvalId}/approve`, manager.token)
      .send({ confirmed: true })
      .expect(409);
    expect((again.body as { code: string }).code).toBe('APPROVAL_INVALID_STATE');

    // 2026-08-28 bug1 语义：已确认排期取消需店长/老板；重复取消（任意角色）仍 409 幂等
    await api('post', `/api/v1/appointments/${apptId}/cancel`, manager.token).expect(200);
    const cancelAgain = await api(
      'post',
      `/api/v1/appointments/${apptId}/cancel`,
      salesA.token,
    ).expect(409);
    expect((cancelAgain.body as { code: string }).code).toBe('APPOINTMENT_INVALID_STATE');

    // 3.3 施工单重复推进：条件更新拦截（同阶段重复自检 → 409）
    const { apptId: appt2 } = await confirmedAppointment({ workbench: `P6RPI${tag}-2` });
    const woRes = await api('post', '/api/v1/work-orders', recorder.token)
      .send({ appointmentId: appt2 })
      .expect(201);
    const woId = (woRes.body as { id: string }).id;
    await api('post', `/api/v1/work-orders/${woId}/start`, recorder.token).expect(200);
    await api('post', `/api/v1/work-orders/${woId}/self-check`, recorder.token)
      .send({})
      .expect(200);
    const selfAgain = await api('post', `/api/v1/work-orders/${woId}/self-check`, recorder.token)
      .send({})
      .expect(409);
    expect((selfAgain.body as { code: string }).code).toBe('WORK_ORDER_INVALID_STATE');

    // 3.4 重复成交：won 后再 won → 409，结论不被覆盖
    const lead = activePrimary!;
    const owner = lead.ownerUserId === salesA.id ? salesA : salesB;
    for (const to of ['contacted', 'communicating', 'visit_booked']) {
      await api('patch', `/api/v1/leads/${lead.id}/stage`, owner.token)
        .send({ stage: to, reason: '幂等测试推进' })
        .expect(200);
    }
    await api('post', `/api/v1/leads/${lead.id}/won`, owner.token)
      .send({ amountFen: 9900, reason: '幂等测试成交' })
      .expect(200);
    const wonAgain = await api('post', `/api/v1/leads/${lead.id}/won`, owner.token)
      .send({ amountFen: 9900, reason: '重复点击成交' })
      .expect(409);
    expect((wonAgain.body as { code: string }).code).toBe('LEAD_INVALID_STATE');
    const final = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(final.closedAmountFen).toBe(9900);
  });
});
