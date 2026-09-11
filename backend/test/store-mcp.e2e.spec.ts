import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MCP_STORE_CALL_LIMIT,
  McpCallGovernorService,
} from '../src/modules/ai-dispatch/mcp-governor/mcp-call-governor.service';
import { STORE_MCP_TOKEN } from '../src/modules/ai-dispatch/store-mcp/store-mcp.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { TEST_MCP_TOKEN } from './test-env';

/** 手机号扫描正则（本地新建，避免共享 /g 正则的 lastIndex 污染，口径同 masker.PHONE_RE） */
const PHONE_SCAN = /1[3-9]\d{9}/g;

interface ToolSpecBody {
  name: string;
  description: string;
  inputSchema: { type: string };
}

interface RpcResponseBody {
  jsonrpc?: string;
  id?: unknown;
  result?: {
    protocolVersion?: string;
    serverInfo?: { name?: string };
    capabilities?: { tools?: unknown };
    tools?: ToolSpecBody[];
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

/** 取响应体并定型（supertest body 为 any，统一在本 helper 收口） */
const rpcBody = (res: request.Response): RpcResponseBody => res.body as RpcResponseBody;

/** 取 tools/call 响应里首个 text 块的文本（断言 type=text） */
const toolText = (res: request.Response): string => {
  const body = rpcBody(res);
  const block = body.result?.content?.[0];
  expect(block?.type).toBe('text');
  return block?.text ?? '';
};

/** 门店 MCP 端点集成测试（M02 Task 1）：streamable-http JSON-RPC 三方法 + 四工具店级脱敏视图。
 * 脱敏策略 = 字段白名单直选：输出结构里根本没有联系方式字段，此处用带敏感数据的关联记录做反证。 */
describe('门店 MCP 端点（M02：四工具店级脱敏视图）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  // 每次运行唯一 tag：测试库数据跨运行残留，计数走「前值 + 增量」口径保持确定性
  const tag = Math.random().toString(36).slice(2, 8);

  const rpc = (method: string, params?: unknown, token: string = TEST_MCP_TOKEN) =>
    request(app.getHttpServer() as Server)
      .post('/api/v1/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method, params });

  const callTool = (name: string, args: Record<string, unknown> = {}) =>
    rpc('tools/call', { name, arguments: args });

  /** 本地时区当日指定时刻（「当日」口径同 ManagerAggregator：服务器本地日界） */
  const todayAt = (hour: number, minute = 0): Date => {
    const d = new Date();
    d.setHours(hour, minute, 0, 0);
    return d;
  };
  const todayKey = (): string => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // 按 tag 清理本套件造的数据（订单/预约/客资/审批/知识/客户）
    await prisma.knowledgeItem.deleteMany({ where: { title: { contains: tag } } });
    await prisma.workOrder.deleteMany({ where: { orderNo: { contains: tag } } });
    await prisma.appointment.deleteMany({ where: { workbench: { contains: tag } } });
    await prisma.approvalItem.deleteMany({ where: { type: `mcp-${tag}` } });
    await prisma.lead.deleteMany({ where: { leadNo: { startsWith: `L-${tag}` } } });
    await prisma.customer.deleteMany({ where: { name: { contains: tag } } });
    await app.close();
  });

  // ─── 协议层：initialize / tools/list / 未知方法 ───

  it('initialize 返回 protocolVersion/serverInfo/capabilities 并回显 id', async () => {
    const res = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      clientInfo: { name: 'openclaw-test', version: '0.0.1' },
    }).expect(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = rpcBody(res);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result?.protocolVersion).toBe('2025-03-26');
    expect(body.result?.serverInfo?.name).toBeTruthy();
    expect(body.result?.capabilities?.tools).toBeDefined();
  });

  it('initialize 请求未知协议版本时回落服务端支持的版本', async () => {
    const res = await rpc('initialize', { protocolVersion: '1999-01-01' }).expect(200);
    expect(rpcBody(res).result?.protocolVersion).toBe('2025-03-26');
  });

  it('tools/list 返回 4 个工具且均含 name/description/inputSchema', async () => {
    const res = await rpc('tools/list').expect(200);
    const tools = rpcBody(res).result?.tools ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual([
      'store_appointments',
      'store_knowledge_search',
      'store_overview',
      'store_work_orders',
    ]);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('未知方法返回 JSON-RPC error -32601；未知工具返回 -32602', async () => {
    const res = await rpc('resources/list').expect(200);
    expect((res.body as RpcResponseBody).error?.code).toBe(-32601);
    const res2 = await callTool('store_secret_dump').expect(200);
    expect((res2.body as RpcResponseBody).error?.code).toBe(-32602);
  });

  // ─── 鉴权：网关 Bearer 令牌（fail-closed） ───

  it('缺少/错误 Bearer 令牌一律 401', async () => {
    await request(app.getHttpServer() as Server)
      .post('/api/v1/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(401);
    await request(app.getHttpServer() as Server)
      .post('/api/v1/mcp')
      .set('Authorization', 'Bearer wrong-token-value')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(401);
  });

  it('WG_MCP_TOKEN 未配置时端点 fail-closed（401）', async () => {
    // 用 buildApp 的 provider 覆盖把网关令牌置空（等价于未配置），验证默认拒绝
    const bare = await buildApp(undefined, [{ token: STORE_MCP_TOKEN, value: '' }]);
    try {
      await request(bare.getHttpServer() as Server)
        .post('/api/v1/mcp')
        .set('Authorization', `Bearer ${TEST_MCP_TOKEN}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        .expect(401);
    } finally {
      await bare.close();
    }
  });

  // ─── 工具一：store_overview（纯计数） ───

  it('store_overview 四项计数正确且响应文本无手机号命中', async () => {
    const dayStart = todayAt(0);
    const dayEnd = new Date(dayStart.getTime() + 86_399_999);
    // 前值（测试库可能有其他套件残留，计数走增量口径保持确定性）
    const [leadsBefore, apptsBefore, woBefore, apprBefore] = await Promise.all([
      prisma.lead.count({ where: { receivedAt: { gte: dayStart, lte: dayEnd } } }),
      prisma.appointment.count({ where: { startAt: { gte: dayStart, lte: dayEnd } } }),
      prisma.workOrder.count({ where: { stage: { not: 'delivered' } } }),
      prisma.approvalItem.count({ where: { status: 'pending' } }),
    ]);
    // 造增量：2 条当日客资（带手机号，验证计数输出不泄漏）+ 1 条当日预约 + 1 张在途工单 + 1 条待审批
    await prisma.lead.createMany({
      data: [
        {
          leadNo: `L-${tag}-ov1`,
          sourceCategory: 'online',
          sourcePlatform: 'test',
          customerName: `客户${tag}`,
          phone: '13800001111',
          receivedAt: new Date(),
        },
        {
          leadNo: `L-${tag}-ov2`,
          sourceCategory: 'offline',
          sourcePlatform: 'test',
          customerName: `客户${tag}`,
          phone: '13900002222',
          receivedAt: new Date(),
        },
      ],
    });
    await prisma.appointment.create({
      data: {
        customerId: `cust-${tag}`,
        serviceItem: `全车膜${tag}`,
        workbench: `${tag}A1`,
        technicianName: '周师傅',
        startAt: new Date(),
        status: 'confirmed',
      },
    });
    await prisma.workOrder.create({
      data: { orderNo: `W-${tag}-ov1`, serviceItem: `贴膜${tag}`, stage: 'pending' },
    });
    await prisma.approvalItem.create({
      data: { type: `mcp-${tag}`, payload: {}, requesterId: 'mcp-test' },
    });

    const res = await callTool('store_overview').expect(200);
    const text = toolText(res);
    expect(text).toContain(`当日新客资：${leadsBefore + 2}`);
    expect(text).toContain(`当日预约：${apptsBefore + 1}`);
    expect(text).toContain(`在途工单（未交付）：${woBefore + 1}`);
    expect(text).toContain(`待审批：${apprBefore + 1}`);
    expect([...text.matchAll(PHONE_SCAN)]).toHaveLength(0);
  });

  // ─── 工具二：store_appointments（排期，白名单无联系方式） ───

  it('store_appointments 输出当日排期且不含电话/微信/车牌', async () => {
    // 关联记录带足敏感字段：客户档案 + 客资都有联系方式，输出若越权选列即命中
    const phone = '13824680278';
    const wechat = `wx_${tag}_secret`;
    await prisma.customer.create({
      data: { name: `客户${tag}`, phone, wechat, plateNo: '粤Y12345' },
    });
    const lead = await prisma.lead.create({
      data: {
        leadNo: `L-${tag}-ap`,
        sourceCategory: 'online',
        sourcePlatform: 'test',
        customerName: `客户${tag}`,
        phone,
        wechat,
      },
    });
    await prisma.appointment.create({
      data: {
        customerId: `cust-${tag}`,
        leadId: lead.id,
        serviceItem: `DM04 前挡${tag}`,
        workbench: `${tag}B2`,
        technicianName: '吴师傅',
        startAt: todayAt(10),
        endAt: todayAt(12),
        status: 'confirmed',
      },
    });

    const res = await callTool('store_appointments', { date: todayKey() }).expect(200);
    const text = toolText(res);
    // 白名单字段可见（正控）
    expect(text).toContain(`DM04 前挡${tag}`);
    expect(text).toContain(`${tag}B2`);
    expect(text).toContain('吴师傅');
    // 联系方式零命中（反证）
    expect(text).not.toContain(phone);
    expect(text).not.toContain(wechat);
    expect(text).not.toContain('粤Y12345');
    expect([...text.matchAll(PHONE_SCAN)]).toHaveLength(0);
  });

  // ─── 工具三：store_work_orders（status 过滤 + limit 上限） ───

  it('store_work_orders 按 status 过滤，limit 超上限截断至 20 并尾注', async () => {
    // 22 张 pending（触发 20 截断）+ 1 张 delivered（status 过滤反证）
    await prisma.workOrder.createMany({
      data: Array.from({ length: 22 }, (_, i) => ({
        orderNo: `W-${tag}-p${String(i).padStart(2, '0')}`,
        serviceItem: `车衣${tag}`,
        workbench: `${tag}C1`,
        technicianName: '郑师傅',
        stage: 'pending',
      })),
    });
    await prisma.workOrder.create({
      data: { orderNo: `W-${tag}-done`, serviceItem: `车衣${tag}`, stage: 'delivered' },
    });

    const res = await callTool('store_work_orders', { status: 'pending', limit: 25 }).expect(200);
    const text = toolText(res);
    expect(text).not.toContain(`W-${tag}-done`);
    const rows = text.split('\n').filter((l) => l.startsWith('W-'));
    expect(rows).toHaveLength(20);
    expect(text).toContain('已截断至 20 条');

    // 默认 limit=10
    const res2 = await callTool('store_work_orders').expect(200);
    const rows2 = toolText(res2)
      .split('\n')
      .filter((l) => l.startsWith('W-'));
    expect(rows2).toHaveLength(10);

    // 非法 status → JSON-RPC -32602
    const resErr = await callTool('store_work_orders', { status: 'bogus' }).expect(200);
    expect((resErr.body as RpcResponseBody).error?.code).toBe(-32602);
  });

  // ─── 工具四：store_knowledge_search（只回 active） ───

  it('store_knowledge_search 命中 active 条目且 draft 不外泄', async () => {
    await prisma.knowledgeItem.createMany({
      data: [
        {
          kind: 'product',
          title: `DM04 说明书（${tag}）`,
          content: `演示品牌 DM04 顶级前挡隔热膜，透光率 70%，红外阻隔率 94%。关键词${tag}。`,
          source: '官方手册',
          status: 'active',
          createdBy: 'mcp-test',
        },
        {
          kind: 'product',
          title: `DM04 草稿（${tag}）`,
          content: `草稿内容关键词${tag}，不应外泄。`,
          source: '内部',
          status: 'draft',
          createdBy: 'mcp-test',
        },
      ],
    });
    const res = await callTool('store_knowledge_search', { keyword: tag }).expect(200);
    const text = toolText(res);
    expect(text).toContain(`DM04 说明书（${tag}）`);
    expect(text).toContain('官方手册');
    expect(text).not.toContain('草稿');
    expect(text).not.toContain('内部');

    // 空 keyword → -32602
    const resErr = await callTool('store_knowledge_search', { keyword: '' }).expect(200);
    expect((resErr.body as RpcResponseBody).error?.code).toBe(-32602);
  });

  it('store_knowledge_search 摘要脱敏：原文电话/微信/车牌不出端点，输出 mask 后形态', async () => {
    // content 是自由文本，案例类知识可能记录客户联系方式——摘要切片必须先过 maskDeep
    const phone = '13824680278';
    const wechat = `wx_${tag}_contact`;
    const plate = '粤Y12345';
    await prisma.knowledgeItem.create({
      data: {
        kind: 'case',
        title: `施工案例（${tag}）`,
        content: `案例：客户 ${phone} 驾驶 ${plate} 到店贴 DM04，微信号 ${wechat}，全程 2 小时。`,
        source: '店长记录',
        status: 'active',
        createdBy: 'mcp-test',
      },
    });

    const res = await callTool('store_knowledge_search', { keyword: tag }).expect(200);
    const text = toolText(res);
    expect(text).toContain(`施工案例（${tag}）`);
    // 原敏感串零命中（反证）
    expect(text).not.toContain(phone);
    expect(text).not.toContain(wechat);
    expect(text).not.toContain(plate);
    expect([...text.matchAll(PHONE_SCAN)]).toHaveLength(0);
    // mask 后形态可见（正控）
    expect(text).toContain('[PHONE]');
    expect(text).toContain('[WECHAT]');
    expect(text).toContain('[PLATE]');
  });

  // ─── F05 修复（2026-09-08 phase12 评测归因）：自由文本出口脱敏补全 ───
  // 白名单 select 挡不住「字段本身就是自由文本」：serviceItem 由店员录入（可能带客户
  // 电话/车牌/微信），知识检索 header 原样回显 keyword（探测实锤：mcp-and-lint.json）。

  it('store_appointments serviceItem 自由文本脱敏：电话/车牌/wxid 不出端点', async () => {
    const phone = '13724680278';
    const plate = '粤E88888';
    const wxid = `wxid_leak${tag.toLowerCase()}`;
    await prisma.appointment.create({
      data: {
        customerId: `cust-${tag}`,
        serviceItem: `客户${phone} ${plate} 贴车衣，联系 ${wxid}`,
        workbench: `${tag}D1`,
        technicianName: '黄师傅',
        startAt: todayAt(14),
        status: 'confirmed',
      },
    });
    const res = await callTool('store_appointments', { date: todayKey() }).expect(200);
    const text = toolText(res);
    expect(text).not.toContain(phone);
    expect(text).not.toContain(plate);
    expect(text).not.toContain(wxid);
    expect([...text.matchAll(PHONE_SCAN)]).toHaveLength(0);
    // 服务项目的非敏感部分仍可读（脱敏不是整段抹掉）
    expect(text).toContain('贴车衣');
    expect(text).toContain('[PHONE]');
  });

  it('store_work_orders serviceItem 自由文本脱敏：同上口径', async () => {
    const phone = '13687654321';
    await prisma.workOrder.create({
      data: {
        orderNo: `W-${tag}-leak`,
        serviceItem: `粤D66666 车主${phone} 全车膜`,
        stage: 'pending',
      },
    });
    const res = await callTool('store_work_orders', { status: 'pending' }).expect(200);
    const text = toolText(res);
    expect(text).not.toContain(phone);
    expect(text).not.toContain('粤D66666');
    expect([...text.matchAll(PHONE_SCAN)]).toHaveLength(0);
    expect(text).toContain('全车膜');
  });

  it('store_knowledge_search header 回显 keyword 脱敏（查询语义不变，仅出口清洗）', async () => {
    const kw = `探测${tag} 13800138000 wxid_probe${tag.toLowerCase()} 粤A12345`;
    const res = await callTool('store_knowledge_search', { keyword: kw }).expect(200);
    const text = toolText(res);
    expect(text).not.toContain('13800138000');
    expect(text).not.toContain('粤A12345');
    expect(text).not.toContain(`wxid_probe${tag.toLowerCase()}`);
    expect([...text.matchAll(PHONE_SCAN)]).toHaveLength(0);
    expect(text).toContain(`探测${tag}`); // 非敏感部分保留（header 仍可对照查询词）
    expect(text).toContain('[PHONE]');
  });

  // ─── F07 硬限次 + F11 审计补链（2026-09-08 phase12 修复）───
  // 网关侧 tool_action 审计不含 MCP 调用（openclaw bundle-mcp 上游限制），后端端点
  // 逐条落库审计并归属在途任务；≤3 次由提示词软约束改为代码硬限（deep-7 六连查回归）。

  it(`在途任务内第 ${MCP_STORE_CALL_LIMIT + 1} 次调用被硬限：isError 引导按已有信息作答`, async () => {
    const governor = app.get(McpCallGovernorService);
    const runId = `task-${tag}-gov`;
    governor.beginRun(runId);
    try {
      for (let i = 0; i < MCP_STORE_CALL_LIMIT; i += 1) {
        const res = await callTool('store_overview').expect(200);
        const body = rpcBody(res);
        expect(body.result?.isError).toBeUndefined();
        expect(body.result?.content?.[0]?.text).toContain('门店总览');
      }
      const over = rpcBody(await callTool('store_overview').expect(200));
      expect(over.result?.isError).toBe(true);
      expect(over.result?.content?.[0]?.text).toContain('查询上限');
      // 超限不执行工具：第 5 次仍是 isError（限制持续生效）
      const fifth = rpcBody(await callTool('store_appointments').expect(200));
      expect(fifth.result?.isError).toBe(true);
    } finally {
      governor.endRun(runId);
    }

    // F11：审计链完整——3 条 tool_call + 2 条 call_rejected，objectId=归属任务 ID
    const calls = await prisma.auditLog.count({
      where: { action: 'ai.mcp.tool_call', objectId: runId },
    });
    const rejected = await prisma.auditLog.count({
      where: { action: 'ai.mcp.call_rejected', objectId: runId },
    });
    expect(calls).toBe(MCP_STORE_CALL_LIMIT);
    expect(rejected).toBe(2);
    // 审计 after 含工具名与归属（以审计证调用，替代网关 tool_action 缺口）
    const sample = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'ai.mcp.tool_call', objectId: runId },
    });
    expect(sample.after).toMatchObject({ tool: 'store_overview', attributedTaskId: runId });
  });

  it('run 结束后调用不再受限（限次按任务隔离，非全局）', async () => {
    const governor = app.get(McpCallGovernorService);
    const runId = `task-${tag}-gov2`;
    governor.beginRun(runId);
    for (let i = 0; i < MCP_STORE_CALL_LIMIT; i += 1) await callTool('store_overview');
    governor.endRun(runId);
    const after = rpcBody(await callTool('store_overview').expect(200));
    expect(after.result?.isError).toBeUndefined();
  });

  it('store_knowledge_search limit 超上限（契约 10）时钳制并尾注截断', async () => {
    // 12 条 active + limit=15 → 实际最多返回 10 条
    const kw = `${tag}kb`;
    await prisma.knowledgeItem.createMany({
      data: Array.from({ length: 12 }, (_, i) => ({
        kind: 'product',
        title: `知识${kw}-${String(i).padStart(2, '0')}`,
        content: `内容${kw}-${i}`,
        source: 'test',
        status: 'active',
        createdBy: 'mcp-test',
      })),
    });

    const res = await callTool('store_knowledge_search', { keyword: kw, limit: 15 }).expect(200);
    const text = toolText(res);
    const rows = text.split('\n').filter((l) => l.startsWith('【product】'));
    expect(rows).toHaveLength(10);
    expect(text).toContain('已截断至 10 条');
  });
});
