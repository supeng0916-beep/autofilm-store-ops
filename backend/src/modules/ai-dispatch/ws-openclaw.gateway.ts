import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

import type { SubmitTaskRequest } from './ai-dispatch.protocol';
import {
  OpenClawTimeoutError,
  type GatewayRunResult,
  type OpenClawGateway,
} from './gateway.interface';

/** WsOpenClawGateway 构造参数：url/token 由模块工厂从 ConfigService 注入；
 * deadlineMs 是 agent.wait 的默认等待上限（测试与缺省兜底用，实际按 request.deadline 截短）；
 * usageFetch 控制 run 结束后 sessions.usage 用量查询的重试节奏（网关用量缓存刷新有秒级延迟，
 * 实测 run 后 ~2s 出数；测试可调小加速）。 */
export interface WsOpenClawGatewayOptions {
  url: string;
  token: string;
  deadlineMs?: number;
  usageFetch?: { attempts?: number; delayMs?: number };
}

const PROTOCOL_VERSION = 4;
const MAX_CONNECT_ATTEMPTS = 3; // P2-03 口径：≤3 次指数退避
const CONNECT_ID = 'wg-connect';
const AGENT_REPLY_TIMEOUT_MS = 5000;
const WAIT_GRACE_MS = 500; // agent.wait 本地定时器比网关 timeoutMs 略长，让网关的 {status:timeout} 先回

/** OpenClaw Gateway 协议 WebSocket+RPC 实现（P3-00，D-P3-1）。
 * 协议依据：docs/personal/notes/openclaw/2026-08-14-gateway-rpc-细节.md（以官方文档为准）。
 * 生产代码只依赖 Node ≥22 内置全局 WebSocket（不引第三方 WS 库）。 */
@Injectable()
export class WsOpenClawGateway implements OpenClawGateway, OnApplicationShutdown {
  private readonly logger = new Logger(WsOpenClawGateway.name);
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private reqSeq = 0;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly collectors = new Map<string, RunCollector>();
  private readonly url: string;
  private readonly token: string;
  private readonly deadlineMs: number;
  private readonly usageAttempts: number;
  private readonly usageDelayMs: number;

  constructor(opts: WsOpenClawGatewayOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.deadlineMs = opts.deadlineMs ?? 30_000;
    this.usageAttempts = opts.usageFetch?.attempts ?? 5;
    this.usageDelayMs = opts.usageFetch?.delayMs ?? 1_000;
  }

  /** 发起 agent run 并在同一连接等待结果；deadline 内未完成抛超时错误 */
  async submit(
    request: SubmitTaskRequest,
    onAssistantText?: (cumulativeText: string) => void,
  ): Promise<GatewayRunResult> {
    if (!this.url || !this.token) {
      throw new Error(
        'OpenClaw 通道未配置（WG_OPENCLAW_GATEWAY_WS_URL / WG_OPENCLAW_GATEWAY_TOKEN）',
      );
    }
    await this.ensureConnected();

    // 1. 发起 run：agent → { runId, acceptedAt }
    // sessionKey 每任务独立（2026-09-07 AB 实测修复）：默认走网关 main 会话会累积
    // 全部历史——tokensIn 从 9k 滚到 31k 触发单任务熔断，且不同任务上下文互相串扰
    // （客户 A 的话术可能带进客户 B 的任务）。全系统多轮连续性均由后端显式注入
    // history（chat 前端拼接/陪练查 roleplayTurn），不依赖网关会话记忆，隔离无副作用。
    const accepted = await this.rpc(
      'agent',
      {
        message: buildMessage(request),
        idempotencyKey: request.taskId,
        sessionKey: `task-${request.taskId}`,
      },
      AGENT_REPLY_TIMEOUT_MS,
    );
    const runId = (accepted as { runId?: unknown } | null)?.runId;
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new Error('OpenClaw agent 未返回 runId');
    }
    const collector = this.collectorFor(runId);
    if (onAssistantText) {
      collector.onText = onAssistantText;
      // 事件可能先于 submit 拿到 runId 到达（同一 TCP 批），回调注册时先补发已缓冲的累计量
      const buffered = collector.fullText ?? collector.textParts.join('');
      if (buffered) onAssistantText(buffered);
    }
    try {
      // 2. 等待终态：agent.wait → { status: ok|error|timeout }
      const timeoutMs = this.waitTimeoutMs(request);
      const waited = await this.rpc('agent.wait', { runId, timeoutMs }, timeoutMs + WAIT_GRACE_MS);
      const status = (waited as { status?: unknown } | null)?.status;
      const result = normalizeResult(status, collector);
      // 2026-08-28 P5：网关事件流不带 usage（2026.7.1+ 实测，lifecycle 只有 phase/时间戳）——
      // run 结束后经 sessions.usage RPC 查该会话真实 token/模型回填结果（尽力而为，不外抛）
      await this.attachUsage(runId, collector, result);
      return result;
    } finally {
      this.collectors.delete(runId);
    }
  }

  /** 健康探测：可连接且握手鉴权通过 */
  async health(): Promise<boolean> {
    if (!this.url || !this.token) return false;
    try {
      await this.ensureConnected();
      return true;
    } catch {
      return false;
    }
  }

  /** 释放连接（应用关闭时） */
  close(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    this.connecting = null;
    rejectAll(this.pending, 'OpenClaw 通道已关闭');
    this.collectors.clear();
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
    return Promise.resolve();
  }

  /** 应用关闭生命周期钩子：释放 WS 连接（main.ts 的 enableShutdownHooks 使其在进程信号时触发） */
  onApplicationShutdown(): Promise<void> {
    return this.close();
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectWithRetry();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connectWithRetry(): Promise<void> {
    let lastError: unknown = new Error('OpenClaw 连接未执行');
    for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt++) {
      try {
        await this.openOnce();
        return;
      } catch (err) {
        lastError = err;
      }
      if (attempt < MAX_CONNECT_ATTEMPTS - 1) {
        await sleep(500 * 2 ** attempt); // 500ms → 1000ms
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** 单次连接 + token 握手；成功后 onmessage 切到 RPC 分发 */
  private openOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      const settle = (fn: () => void) => () => {
        if (!settled) {
          settled = true;
          fn();
        }
      };
      ws.onopen = () => ws.send(JSON.stringify(this.connectFrame()));
      ws.onmessage = (ev: MessageEvent) => {
        const frame = parseFrame(ev.data);
        if (!frame || frame.type !== 'res' || frame.id !== CONNECT_ID) return;
        if (frame.ok) {
          ws.onmessage = (ev2: MessageEvent) => this.handleMessage(ev2.data);
          settle(resolve)();
        } else {
          settle(() => {
            ws.close();
            reject(toError(frame.error));
          })();
        }
      };
      ws.onerror = () => settle(() => reject(new Error('OpenClaw 连接失败')))();
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        rejectAll(this.pending, 'OpenClaw 连接关闭');
        settle(() => reject(new Error('OpenClaw 连接关闭')))();
      };
    });
  }

  private handleMessage(data: unknown): void {
    const frame = parseFrame(data);
    if (!frame) return;
    if (frame.type === 'res') {
      const pending = this.pending.get(frame.id ?? '');
      if (!pending) return;
      this.pending.delete(frame.id ?? '');
      if (frame.ok) pending.resolve(frame.payload ?? null);
      else pending.reject(toError(frame.error));
    } else if (frame.type === 'event' && frame.event === 'agent') {
      this.handleAgentEvent(frame.payload);
    } else if (frame.type === 'event' && frame.event === 'chat') {
      this.handleChatEvent(frame.payload);
    }
  }

  private handleAgentEvent(payload: unknown): void {
    const ev = payload as {
      runId?: unknown;
      sessionKey?: unknown;
      stream?: unknown;
      data?: unknown;
    } | null;
    const runId = ev?.runId;
    if (typeof runId !== 'string') return;
    // 事件可能先于 submit 拿到 runId 到达（同一 TCP 批内），这里自动建 collector 缓冲，
    // 避免「res 已 resolve、微任务尚未注册 collector」导致丢帧
    const collector = this.collectorFor(runId);
    if (typeof ev?.sessionKey === 'string') collector.sessionKey = ev.sessionKey;
    const data = ev?.data as
      | {
          text?: unknown;
          delta?: unknown;
          phase?: unknown;
          usage?: unknown;
          model?: unknown;
          costEstimateFen?: unknown;
        }
      | undefined;
    if (ev?.stream === 'assistant') {
      // 网关 2026.7.1+ 语义：data.text=累计全文（后到覆盖），data.delta=增量；
      // 旧版只有 delta 型 text。两者共存时优先累计全文，避免「{" + 全文」拼接成非法 JSON
      if (typeof data?.text === 'string') collector.fullText = data.text;
      else if (typeof data?.delta === 'string') collector.textParts.push(data.delta);
      collector.onText?.(collector.fullText ?? collector.textParts.join(''));
    } else if (ev?.stream === 'lifecycle') {
      if (typeof data?.phase === 'string') collector.phase = data.phase;
      if (data?.usage) collector.usage = data.usage as GatewayRunResult['usage'];
      if (typeof data?.model === 'string') collector.model = data.model;
      if (typeof data?.costEstimateFen === 'number')
        collector.costEstimateFen = data.costEstimateFen;
    }
  }

  /** chat 事件（state=final）为权威终稿全文：兜底/覆盖累计文本 */
  private handleChatEvent(payload: unknown): void {
    const ev = payload as {
      runId?: unknown;
      sessionKey?: unknown;
      state?: unknown;
      message?: { content?: Array<{ type?: string; text?: unknown }> };
    } | null;
    if (ev?.state !== 'final' || typeof ev.runId !== 'string') return;
    if (typeof ev.sessionKey === 'string') this.collectorFor(ev.runId).sessionKey = ev.sessionKey;
    const texts = (ev.message?.content ?? [])
      .filter((c) => typeof c.text === 'string')
      .map((c) => String(c.text));
    if (texts.length > 0) this.collectorFor(ev.runId).fullText = texts.join('');
  }

  private collectorFor(runId: string): RunCollector {
    let collector = this.collectors.get(runId);
    if (!collector) {
      collector = { textParts: [] };
      this.collectors.set(runId, collector);
    }
    return collector;
  }

  private rpc(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('OpenClaw 未连接');
    }
    const id = `req-${++this.reqSeq}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // agent.wait 本地定时器到期 = run 等待超 deadline，抛可识别超时错误（submitTask 降级 reason='timeout'）；
        // 其余方法（agent/connect 等）超时仍属提交/连接失败
        reject(
          method === 'agent.wait'
            ? new OpenClawTimeoutError()
            : new Error(`OpenClaw RPC ${method} 超时`),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  /** 用量回填（2026-08-28 P5）：网关 agent/chat 事件流不携带 usage（2026.7.1+ 实测），但网关侧
   * 会话落盘有真实 token/模型，经 sessions.usage RPC（operator.read，connect 时已授权）可查。
   * 网关用量缓存刷新有秒级延迟（实测 run 后 ~2s 出数）→ 小步重试；当前版本事件流若直接带
   * usage（未来版本/测试 fake）则优先事件值不再查询。尽力而为：查不到仅 warn，任务结果不受影响。 */
  private async attachUsage(
    runId: string,
    collector: RunCollector,
    result: GatewayRunResult,
  ): Promise<void> {
    if (collector.usage) return; // 事件流已带 usage（未来网关版本），无需查询
    const key = collector.sessionKey ?? `agent:main:explicit:${runId}`;
    for (let attempt = 1; attempt <= this.usageAttempts; attempt++) {
      try {
        const payload = (await this.rpc('sessions.usage', { key }, 10_000)) as {
          sessions?: Array<{ usage?: { input?: unknown; output?: unknown }; model?: unknown }>;
        } | null;
        const session = payload?.sessions?.find((s) => s.usage);
        const tokensIn = session ? asFiniteInt(session.usage?.input) : null;
        const tokensOut = session ? asFiniteInt(session.usage?.output) : null;
        if (session && tokensIn !== null && tokensOut !== null) {
          result.usage = { tokensIn, tokensOut };
          if (!result.model && typeof session.model === 'string') result.model = session.model;
          return;
        }
      } catch (err) {
        this.logger.warn(
          `sessions.usage 查询失败（runId=${runId}，第 ${attempt} 次）：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      if (attempt < this.usageAttempts) await sleep(this.usageDelayMs);
    }
    this.logger.warn(`sessions.usage 未取到用量（${key}）：token/成本留空`);
  }

  private waitTimeoutMs(request: SubmitTaskRequest): number {
    const deadline = Date.parse(request.deadline);
    if (Number.isFinite(deadline)) {
      const remaining = deadline - Date.now();
      if (remaining > 0) return Math.min(this.deadlineMs, remaining);
    }
    return this.deadlineMs;
  }

  private connectFrame(): unknown {
    return {
      type: 'req',
      id: CONNECT_ID,
      method: 'connect',
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: { id: 'gateway-client', version: '1.0.0', platform: 'node', mode: 'backend' },
        role: 'operator',
        scopes: ['operator.read', 'operator.write'],
        auth: { token: this.token },
      },
    };
  }
}

interface PendingRpc {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

interface RunCollector {
  /** 旧版网关：增量分片按序追加 */
  textParts: string[];
  /** 新版网关（2026.7.1+）：assistant.text 累计全文 / chat.final 终稿，后到覆盖 */
  fullText?: string;
  /** 流式回调（2026-08-26）：assistant 事件到达时以累计原文回调（submit 可选注入） */
  onText?: (cumulativeText: string) => void;
  /** 会话键（events.sessionKey；sessions.usage 用量查询键，P5） */
  sessionKey?: string;
  phase?: string;
  usage?: GatewayRunResult['usage'];
  model?: string;
  costEstimateFen?: number;
}

interface WireFrame {
  type: 'req' | 'res' | 'event';
  id?: string;
  ok?: boolean;
  event?: string;
  payload?: unknown;
  error?: { code?: string; message?: string };
}

function parseFrame(data: unknown): WireFrame | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed = JSON.parse(data) as WireFrame;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.type !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function toError(error: { code?: string; message?: string } | undefined): Error {
  return new Error(error?.message ?? `OpenClaw 返回错误${error?.code ? `（${error.code}）` : ''}`);
}

/** unknown → 有限整数（网关 usage 数值防御性收窄），非有限数值返回 null */
function asFiniteInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function rejectAll(pending: Map<string, PendingRpc>, message: string): void {
  for (const [, p] of pending) p.reject(new Error(message));
  pending.clear();
}

function buildMessage(request: SubmitTaskRequest): string {
  // 消息载荷透传给 skill：SKILL.md 指示模型据此输出严格 JSON（taskType/context/constraints）
  return JSON.stringify({
    taskId: request.taskId,
    taskType: request.taskType,
    context: request.context,
    constraints: request.constraints,
  });
}

function normalizeResult(status: unknown, collector: RunCollector): GatewayRunResult {
  if (status === 'ok') {
    // 累计全文优先（新版网关），无则回退增量拼接（旧版）
    const raw = (collector.fullText ?? collector.textParts.join('')).trim();
    return {
      status: 'done',
      output: parseOutput(raw),
      usage: collector.usage,
      model: collector.model,
      costEstimateFen: collector.costEstimateFen,
    };
  }
  if (status === 'timeout') {
    throw new OpenClawTimeoutError();
  }
  return {
    status: 'failed',
    errorMessage: 'OpenClaw run 执行失败',
  };
}

function parseOutput(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    // 模型（如 MiniMax-M3）可能在终稿 JSON 前输出推理文字：提取全部顶层 JSON 对象，
    // 取最后一个可解析者（终稿在末尾）；字符串内的花括号不计入深度
  }
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(candidates[i]);
    } catch {
      continue;
    }
  }
  return { text: raw };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
