import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';
import { WO_STAGE, WO_STAGE_LABEL, WO_STAGE_VALUES } from '../../delivery/work-order.states';
import { maskDeep } from '../masker';

/** 列表行数硬上限（M02 任务契约）：列表工具统一截断线（工单） */
export const STORE_MCP_ROW_LIMIT = 20;

/** 知识检索条数硬上限（M02 任务契约）：store_knowledge_search limit≤10 */
export const STORE_MCP_KNOWLEDGE_LIMIT = 10;

/** 截断尾注（M02 契约原文）：「（已截断至 N 条）」 */
const truncationNote = (limit: number): string => `（已截断至 ${limit} 条）`;

/** 工具入参错误：控制器层映射为 JSON-RPC -32602（Invalid params） */
export class StoreMcpArgError extends Error {}

/** 简化 JSON Schema 子集（tools/list 的 inputSchema 声明，模型可读） */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, { type: 'string' | 'number'; description: string }>;
  required?: string[];
  additionalProperties: false;
}

export interface StoreMcpToolSpec {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

const dateInput = (description: string) => ({ type: 'string' as const, description });

/** 四工具声明（tools/list 输出） */
export const STORE_MCP_TOOL_SPECS: StoreMcpToolSpec[] = [
  {
    name: 'store_overview',
    description:
      '门店当日总览计数：当日新客资数、当日预约数、在途工单数（非已交付）、待审批数。纯数字，无明细。',
    inputSchema: {
      type: 'object',
      properties: { date: dateInput('查询日期，YYYY-MM-DD，缺省为今天') },
      additionalProperties: false,
    },
  },
  {
    name: 'store_appointments',
    description: '指定日排期列表：服务项目/工位/技师/状态/起止时间。不含客户任何联系方式。',
    inputSchema: {
      type: 'object',
      properties: { date: dateInput('查询日期，YYYY-MM-DD，缺省为今天') },
      additionalProperties: false,
    },
  },
  {
    name: 'store_work_orders',
    description: '工单列表：单号/阶段/服务项目/工位/技师/建单时间。不含客户与客资关联信息。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: `按阶段过滤：${WO_STAGE_VALUES.join(' / ')}` },
        limit: { type: 'number', description: '返回条数，默认 10，上限 20' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'store_knowledge_search',
    description:
      '知识库检索：按关键词匹配标题或内容，只返回已生效（active）条目的类别/标题/摘要（前 300 字，联系方式已脱敏）/来源。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '检索关键词（标题/内容 contains 匹配）' },
        limit: { type: 'number', description: '返回条数，默认 5，上限 10' },
      },
      required: ['keyword'],
      additionalProperties: false,
    },
  },
];

// ─── 本地时区日期工具（「当日」口径同 ManagerAggregator：服务器本地日界） ───

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number): string => String(n).padStart(2, '0');
const hhmm = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const mmddhhmm = (d: Date): string => `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm(d)}`;
const dateKey = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 解析 date 入参为当日 00:00（本地时区）；缺省=今天；非法格式抛 -32602 语义错 */
function localDayStart(input: unknown): Date {
  if (input === undefined || input === null || input === '') {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (typeof input !== 'string' || !DATE_RE.test(input)) {
    throw new StoreMcpArgError('date 须为 YYYY-MM-DD 格式字符串');
  }
  const [y, m, d] = input.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    throw new StoreMcpArgError(`date 不是合法日期：${input}`);
  }
  return dt;
}

/** 解析 limit 入参：缺省取默认值；非正整数报错；钳到各工具硬上限（契约：工单 20 / 知识检索 10） */
function parseLimit(input: unknown, fallback: number, hardCap: number): number {
  if (input === undefined || input === null) return fallback;
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1) {
    throw new StoreMcpArgError('limit 须为正整数');
  }
  return Math.min(input, hardCap);
}

const APPT_STATUS_LABEL: Record<string, string> = {
  pending: '待确认',
  confirmed: '已确认',
  cancelled: '已取消',
};

/** 拼接列表文本：首行头 + 数据行 + 截断尾注（发生截断时） */
function joinList(header: string, lines: string[], truncated: boolean, limit: number): string {
  const body = truncated ? [...lines, truncationNote(limit)] : lines;
  return [header, ...body].join('\n');
}

/** 自由文本字段出口脱敏（F05 修复，2026-09-08 phase12 评测归因）：白名单 select
 * 挡不住「字段本身就是自由文本」——serviceItem/workbench/technicianName 由店员录入，
 * 服务级夹具实测带出电话/车牌/wxid（mcp-free-text-fixture.json）；知识检索 header
 * 对 keyword 的原样回显同属此类（mcp-and-lint.json 探测实锤）。统一过 maskDeep
 * 内容正则（电话/车牌/wxid/微信号标签），查询语义不变、仅出口清洗。 */
const maskText = (value: string | null | undefined, fallback: string): string =>
  value ? String(maskDeep(value)) : fallback;

/** 四工具实现（M02 Task 1）：只读、字段白名单直选——select 里根本没有联系方式字段，
 * 输出结构不可能携带敏感数据（比事后清洗更强的脱敏）。列表行数：工单/排期截断线 20、
 * 知识检索 10（任务契约），截断附尾注。自由文本出口（知识 title/source/摘要、排期/工单
 * serviceItem/workbench/technicianName、检索 header 的 keyword 回显）一律过 maskDeep（F05）。 */
@Injectable()
export class StoreMcpTools {
  constructor(private readonly prisma: PrismaService) {}

  readonly specs = STORE_MCP_TOOL_SPECS;

  /** 工具分派入口；未知工具按入参错误处理（-32602） */
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'store_overview':
        return this.overview(args['date']);
      case 'store_appointments':
        return this.appointments(args['date']);
      case 'store_work_orders':
        return this.workOrders(args['status'], args['limit']);
      case 'store_knowledge_search':
        return this.knowledgeSearch(args['keyword'], args['limit']);
      default:
        throw new StoreMcpArgError(`未知工具：${name}`);
    }
  }

  /** 门店总览：四项纯计数（无明细，天然无敏感字段） */
  private async overview(dateInput: unknown): Promise<string> {
    const start = localDayStart(dateInput);
    const end = new Date(start.getTime() + 86_399_999);
    const [newLeads, appts, inTransit, pendingApprovals] = await Promise.all([
      // 新客资口径：receivedAt（SLA 起点/登记时间）落当日
      this.prisma.lead.count({ where: { receivedAt: { gte: start, lte: end } } }),
      // 预约口径：startAt 落当日（取消的也计入当日排期事实）
      this.prisma.appointment.count({ where: { startAt: { gte: start, lte: end } } }),
      // 在途口径：非终态（唯一终态为 delivered/已交付）
      this.prisma.workOrder.count({ where: { stage: { not: WO_STAGE.DELIVERED } } }),
      this.prisma.approvalItem.count({ where: { status: 'pending' } }),
    ]);
    return [
      `门店总览（${dateKey(start)}）`,
      `当日新客资：${newLeads}`,
      `当日预约：${appts}`,
      `在途工单（未交付）：${inTransit}`,
      `待审批：${pendingApprovals}`,
    ].join('\n');
  }

  /** 当日排期：白名单 select（无 customerId/leadId 等任何客户关联列） */
  private async appointments(dateInput: unknown): Promise<string> {
    const start = localDayStart(dateInput);
    const end = new Date(start.getTime() + 86_399_999);
    const rows = await this.prisma.appointment.findMany({
      where: { startAt: { gte: start, lte: end } },
      orderBy: { startAt: 'asc' },
      take: STORE_MCP_ROW_LIMIT + 1, // 多取 1 条用于探测截断
      select: {
        serviceItem: true,
        workbench: true,
        technicianName: true,
        status: true,
        startAt: true,
        endAt: true,
      },
    });
    const truncated = rows.length > STORE_MCP_ROW_LIMIT;
    const shown = rows.slice(0, STORE_MCP_ROW_LIMIT);
    const lines = shown.map(
      (a) =>
        `${hhmm(a.startAt)}-${a.endAt ? hhmm(a.endAt) : '未定'}｜${maskText(a.serviceItem, '未填项目')}｜工位 ${maskText(a.workbench, '未排')}｜技师 ${maskText(a.technicianName, '未指定')}｜${APPT_STATUS_LABEL[a.status] ?? a.status}`,
    );
    return joinList(
      `当日排期（${dateKey(start)}，共 ${shown.length}${truncated ? '+' : ''} 条）`,
      lines,
      truncated,
      STORE_MCP_ROW_LIMIT,
    );
  }

  /** 工单列表：白名单 select（无 customerId/opportunityId/leadId 关联列） */
  private async workOrders(statusInput: unknown, limitInput: unknown): Promise<string> {
    const limit = parseLimit(limitInput, 10, STORE_MCP_ROW_LIMIT);
    let stage: string | undefined;
    if (statusInput !== undefined && statusInput !== null && statusInput !== '') {
      if (
        typeof statusInput !== 'string' ||
        !WO_STAGE_VALUES.includes(statusInput as (typeof WO_STAGE_VALUES)[number])
      ) {
        throw new StoreMcpArgError(`status 须为 ${WO_STAGE_VALUES.join('/')} 之一`);
      }
      stage = statusInput;
    }
    const rows = await this.prisma.workOrder.findMany({
      where: stage ? { stage } : {},
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      select: {
        orderNo: true,
        stage: true,
        serviceItem: true,
        workbench: true,
        technicianName: true,
        createdAt: true,
      },
    });
    const truncated = rows.length > limit;
    const shown = rows.slice(0, limit);
    const stageLabel = WO_STAGE_LABEL as Record<string, string>;
    const lines = shown.map(
      (w) =>
        `${w.orderNo}｜${stageLabel[w.stage] ?? w.stage}｜${maskText(w.serviceItem, '未填项目')}｜工位 ${maskText(w.workbench, '未排')}｜技师 ${maskText(w.technicianName, '未指派')}｜建单 ${mmddhhmm(w.createdAt)}`,
    );
    return joinList(
      `工单列表（${stage ? `阶段=${stageLabel[stage] ?? stage}，` : ''}共 ${shown.length}${truncated ? '+' : ''} 条）`,
      lines,
      truncated,
      limit,
    );
  }

  /** 知识检索：contains 简版（标题/内容不区分大小写），只回 active；摘要取前 300 字。
   * 摘要脱敏（评审 Important-1）：content 是自由文本，案例类知识可能记录客户电话/微信/车牌，
   * 白名单挡不住正文——先对全文 maskDeep 再截断（先截后脱敏会在 300 字边界残留
   * 匹配不到正则的半截号码）；截掉半个占位符仅影响观感，收尾清理掉。 */
  private async knowledgeSearch(keywordInput: unknown, limitInput: unknown): Promise<string> {
    if (typeof keywordInput !== 'string' || keywordInput.trim() === '') {
      throw new StoreMcpArgError('keyword 须为非空字符串');
    }
    const keyword = keywordInput.trim();
    const limit = parseLimit(limitInput, 5, STORE_MCP_KNOWLEDGE_LIMIT);
    const rows = await this.prisma.knowledgeItem.findMany({
      where: {
        status: 'active',
        OR: [
          { title: { contains: keyword, mode: 'insensitive' } },
          { content: { contains: keyword, mode: 'insensitive' } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: limit + 1,
      select: { kind: true, title: true, content: true, source: true },
    });
    const truncated = rows.length > limit;
    const shown = rows.slice(0, limit);
    const lines = shown.map((k) => {
      // title/source 同为店员录入的自由文本，与摘要一并过 maskDeep（红线：联系方式不出端点）
      const title = String(maskDeep(k.title));
      const source = k.source ? `（来源：${String(maskDeep(k.source))}）` : '';
      const summary = String(maskDeep(k.content))
        .slice(0, 300)
        .replace(/\[[A-Z]{0,8}$/, '');
      return `【${k.kind}】${title}${source}\n  摘要：${summary}`;
    });
    return joinList(
      `知识检索「${String(maskDeep(keyword))}」（共 ${shown.length}${truncated ? '+' : ''} 条）`,
      lines,
      truncated,
      limit,
    );
  }
}
