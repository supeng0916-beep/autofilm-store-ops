import { WebSocketServer, type WebSocket } from 'ws';

/** 测试内 OpenClaw Gateway 替身（P3-00，D-P3-1）：按官方 Gateway 协议（WS 文本帧 JSON）实现
 * 最小握手 + agent + agent.wait + agent 事件三段式。协议依据：
 * docs/personal/notes/openclaw/2026-08-14-gateway-rpc-细节.md。仅测试用，生产不引 ws。 */

export interface FakeRunResult {
  output?: unknown;
  usage?: { tokensIn: number; tokensOut: number };
  model?: string;
  costEstimateFen?: number;
  /** 直接指定模型终稿原文（如「推理前缀 + JSON」混合文本），优先于 output */
  rawText?: string;
}

export interface FakeOpenClawGatewayOptions {
  token: string;
  /** 收到 agent run 请求时回的结果；缺省回 { greeting:'hi', model:'fake' } */
  onRun?: (req: unknown) => FakeRunResult;
  /** 'ok'（默认）回终态；'silent' 不回（测客户端本地超时）；'error'/'timeout' 回对应终态 */
  waitMode?: 'ok' | 'silent' | 'error' | 'timeout';
  /** 'single'（默认）单条 assistant 全文事件（旧版网关）；
   * 'chunked' 模拟网关 2026.7.1+：多条 assistant 事件（data.text=累计全文 + data.delta=增量）+ chat final 终稿 */
  streamStyle?: 'single' | 'chunked';
  /** sessions.usage 会话用量（2026-08-28 P5）：事件流不带 usage 时客户端经该 RPC 取数；
   * 缺省 {input:100, output:40}（保证既有用例不空转重试） */
  sessionUsage?: { input: number; output: number } | null;
  /** sessions.usage 前 N 次查询回 usage:null（模拟网关用量缓存刷新延迟） */
  usageNullFirst?: number;
  /** sessions.usage 一律回错（模拟网关不支持/故障，客户端须不阻断任务） */
  usageError?: boolean;
}

export interface FakeOpenClawGateway {
  url: string;
  received: unknown[];
  /** sessions.usage 收到的 key 列表（断言查询键用） */
  usageQueries: string[];
  /** 服务端观察到的客户端连接关闭次数（含优雅 close 与 terminate） */
  closedCount: number;
  close: () => Promise<void>;
}

export function startFakeOpenClawGateway(
  opts: FakeOpenClawGatewayOptions,
): Promise<FakeOpenClawGateway> {
  const received: unknown[] = [];
  const usageQueries: string[] = [];
  const usageNullRemaining = new Map<string, number>();
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  let runSeq = 0;
  let closedCount = 0;

  wss.on('connection', (socket: WebSocket) => {
    socket.on('close', () => {
      closedCount += 1;
    });
    socket.on('message', (data) => {
      const frame = parse(data);
      if (!frame || frame.type !== 'req') return;
      const id = frame.id;
      if (frame.method === 'connect') {
        const token = (frame.params as { auth?: { token?: unknown } } | undefined)?.auth?.token;
        if (token !== opts.token) {
          send(socket, {
            type: 'res',
            id,
            ok: false,
            error: { code: 'FORBIDDEN', message: 'invalid token' },
          });
          return;
        }
        send(socket, {
          type: 'res',
          id,
          ok: true,
          payload: {
            type: 'hello-ok',
            protocol: 4,
            auth: { role: 'operator', scopes: ['operator.read', 'operator.write'] },
          },
        });
        return;
      }
      if (frame.method === 'agent') {
        received.push(frame.params);
        const runId = `run-${++runSeq}`;
        const sessionKey = `agent:main:explicit:${runId}`;
        // 先回 agent 结果（runId），再推事件流——与真实协议「先 accepted 后流式」一致，
        // 也保证客户端拿到 runId 注册 collector 后事件才到（避免丢帧）
        send(socket, { type: 'res', id, ok: true, payload: { runId, acceptedAt: Date.now() } });
        const result = opts.onRun ? opts.onRun(frame.params) : {};
        const outputText =
          result.rawText ?? JSON.stringify(result.output ?? { greeting: 'hi', model: 'fake' });
        if (opts.streamStyle === 'chunked') {
          // 网关 2026.7.1+ 实测格式：assistant.data.text 为累计全文（截半 + 全文两条），chat final 为终稿
          const half = outputText.slice(0, Math.max(1, Math.floor(outputText.length / 2)));
          for (const [seq, text] of [
            [6, half],
            [11, outputText],
          ] as Array<[number, string]>) {
            send(socket, {
              type: 'event',
              event: 'agent',
              payload: {
                runId,
                sessionKey,
                seq,
                stream: 'assistant',
                ts: Date.now(),
                data: { text, delta: text },
              },
            });
          }
          send(socket, {
            type: 'event',
            event: 'chat',
            payload: {
              runId,
              sessionKey,
              seq: 13,
              state: 'final',
              stopReason: 'stop',
              message: { role: 'assistant', content: [{ type: 'text', text: outputText }] },
            },
          });
        } else {
          send(socket, {
            type: 'event',
            event: 'agent',
            payload: {
              runId,
              sessionKey,
              seq: 0,
              stream: 'assistant',
              ts: Date.now(),
              data: { text: outputText },
            },
          });
        }
        if (result.usage || result.model || result.costEstimateFen !== undefined) {
          send(socket, {
            type: 'event',
            event: 'agent',
            payload: {
              runId,
              sessionKey,
              seq: 1,
              stream: 'lifecycle',
              ts: Date.now(),
              data: {
                phase: 'end',
                usage: result.usage,
                model: result.model,
                costEstimateFen: result.costEstimateFen,
              },
            },
          });
        }
        return;
      }
      if (frame.method === 'sessions.usage') {
        // 2026-08-28 P5：真实网关事件流不带 usage，run 结束后客户端经此 RPC 查会话用量
        const keyParam = (frame.params as { key?: unknown } | undefined)?.key;
        const key = typeof keyParam === 'string' ? keyParam : '';
        usageQueries.push(key);
        if (opts.usageError) {
          send(socket, {
            type: 'res',
            id,
            ok: false,
            error: { code: 'INVALID_REQUEST', message: 'sessions.usage unavailable' },
          });
          return;
        }
        const nullLeft = (usageNullRemaining.get(key) ?? opts.usageNullFirst ?? 0) - 1;
        usageNullRemaining.set(key, Math.max(0, nullLeft));
        const usage = nullLeft >= 0 ? null : (opts.sessionUsage ?? { input: 100, output: 40 });
        send(socket, {
          type: 'res',
          id,
          ok: true,
          payload: {
            sessions: [{ key, model: 'MiniMax-M3', usage }],
            totals: {},
            cacheStatus: { status: nullLeft >= 0 ? 'refreshing' : 'fresh' },
          },
        });
        return;
      }
      if (frame.method === 'agent.wait') {
        if (opts.waitMode === 'silent') return; // 不回 → 客户端本地定时器超时
        if (opts.waitMode === 'error') {
          send(socket, { type: 'res', id, ok: true, payload: { status: 'error' } });
          return;
        }
        if (opts.waitMode === 'timeout') {
          send(socket, { type: 'res', id, ok: true, payload: { status: 'timeout' } });
          return;
        }
        send(socket, {
          type: 'res',
          id,
          ok: true,
          payload: { status: 'ok', startedAt: Date.now() - 10, endedAt: Date.now() },
        });
      }
    });
  });

  return new Promise((resolve, reject) => {
    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `ws://127.0.0.1:${port}`,
        received,
        usageQueries,
        get closedCount() {
          return closedCount;
        },
        // 先终止所有已连接客户端再关服务器：wss.close() 会等待活动连接断开，
        // 客户端（WsOpenClawGateway）保持长连接时直接 close 会挂起（e2e afterAll 超时）
        close: () =>
          new Promise<void>((resolveClose) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => resolveClose());
          }),
      });
    });
    wss.on('error', reject);
  });
}

interface WireFrame {
  type: string;
  id?: string;
  method?: string;
  params?: unknown;
}

function parse(data: unknown): WireFrame | null {
  try {
    const parsed = JSON.parse(String(data)) as WireFrame;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

function send(socket: WebSocket, frame: unknown): void {
  socket.send(JSON.stringify(frame));
}
