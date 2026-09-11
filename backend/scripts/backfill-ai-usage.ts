/** 历史任务用量回填（2026-08-28 P5）：AI 通道管理的 token/成本此前恒为 0——
 * 网关事件流不带 usage，ai_tasks.tokens_in/out 与 cost_estimate_fen 一直空置。
 * 修复（网关 submit 后经 sessions.usage 查询）只对新任务生效；本脚本对历史任务按
 * 网关会话落盘补记：task.id 即网关 runId（idempotencyKey），会话键 agent:main:explicit:<taskId>。
 *
 * 数据来源：OpenClaw 网关 sessions.usage RPC（operator.read）；成本按 ai-pricing 单价表估算
 * （可用 WG_AI_MODEL_PRICES_FEN_PER_MTOK 覆盖，与在线记账同口径）。
 *
 * 用法（cd backend）：
 *   WG_DATABASE_URL=postgresql://autofilm:autofilm@localhost:5432/autofilm_dev \
 *   WG_OPENCLAW_GATEWAY_WS_URL=ws://127.0.0.1:18789 WG_OPENCLAW_GATEWAY_TOKEN=*** \
 *   npm run backfill:ai-usage -- --days=30
 *   # 先看会补多少（不动库）：加 --dry-run
 */
import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { estimateCostFen, parseModelPrices } from '../src/modules/ai-dispatch/ai-pricing';
import { requireDbUrl } from './db-env';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DAYS_ARG = args.find((a) => a.startsWith('--days='));
const DAYS = DAYS_ARG ? Number(DAYS_ARG.slice('--days='.length)) : 30;

interface UsageSession {
  key?: string;
  model?: string;
  usage?: { input?: number; output?: number } | null;
}

/** 网关 usage 数值防御性收窄：非有限数值返回 null */
function finiteInt(value: number | undefined | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/** 连接网关 → connect 握手 → 逐会话键查 sessions.usage（带重试应对用量缓存刷新延迟） */
async function connectGateway(): Promise<{
  rpc: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
  close: () => void;
}> {
  const url = process.env.WG_OPENCLAW_GATEWAY_WS_URL?.trim();
  const token = process.env.WG_OPENCLAW_GATEWAY_TOKEN?.trim();
  if (!url || !token)
    throw new Error('缺少 WG_OPENCLAW_GATEWAY_WS_URL / WG_OPENCLAW_GATEWAY_TOKEN');
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ws.onmessage = (ev) => {
    const frame = JSON.parse(String(ev.data)) as {
      type: string;
      id?: string;
      ok?: boolean;
      payload?: unknown;
      error?: { message?: string };
    };
    if (frame.type !== 'res') return;
    const p = pending.get(frame.id ?? '');
    if (!p) return;
    pending.delete(frame.id ?? '');
    if (frame.ok) p.resolve(frame.payload ?? null);
    else p.reject(new Error(frame.error?.message ?? 'gateway rpc error'));
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('网关连接失败'));
    setTimeout(() => reject(new Error('网关连接超时')), 10_000);
  });
  const rpc = (method: string, params: unknown, timeoutMs: number) =>
    new Promise<unknown>((resolve, reject) => {
      const id = `bf-${++seq}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`rpc ${method} 超时`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  await rpc(
    'connect',
    {
      minProtocol: 4,
      maxProtocol: 4,
      client: { id: 'gateway-client', version: '1.0.0', platform: 'node', mode: 'backend' },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      auth: { token },
    },
    10_000,
  );
  return { rpc, close: () => ws.close() };
}

async function main(): Promise<number> {
  const url = requireDbUrl(process.env);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const since = new Date();
  since.setDate(since.getDate() - DAYS);

  const tasks = await prisma.aiTask.findMany({
    where: { createdAt: { gte: since }, tokensIn: null },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  console.log(
    `近 ${DAYS} 天缺用量的任务：${tasks.length} 条${DRY_RUN ? '（dry-run，不动库）' : ''}`,
  );
  if (tasks.length === 0) return 0;

  const gateway = await connectGateway();
  const prices = parseModelPrices(process.env.WG_AI_MODEL_PRICES_FEN_PER_MTOK);
  let filled = 0;
  let missing = 0;
  try {
    for (const task of tasks) {
      const key = `agent:main:explicit:${task.id}`;
      let session: UsageSession | undefined;
      // 用量缓存刷新有秒级延迟：小步重试
      for (let attempt = 1; attempt <= 4 && !session?.usage; attempt++) {
        try {
          const payload = (await gateway.rpc('sessions.usage', { key }, 15_000)) as {
            sessions?: UsageSession[];
          } | null;
          session = payload?.sessions?.find((s) => s.usage);
        } catch {
          break; // 会话不存在/网关不支持 → 不再重试
        }
        if (!session?.usage) await new Promise((r) => setTimeout(r, 1_000));
      }
      const usage = session?.usage;
      const tokensIn = session ? finiteInt(usage?.input) : null;
      const tokensOut = session ? finiteInt(usage?.output) : null;
      if (tokensIn === null || tokensOut === null) {
        missing += 1;
        continue;
      }
      const model = session?.model ?? null;
      const cost = estimateCostFen(model ?? undefined, tokensIn, tokensOut, prices) ?? undefined;
      if (!DRY_RUN) {
        await prisma.aiTask.update({
          where: { id: task.id },
          data: {
            tokensIn,
            tokensOut,
            ...(model ? { model } : {}),
            ...(cost !== undefined ? { costEstimateFen: cost } : {}),
          },
        });
      }
      filled += 1;
      console.log(
        `${DRY_RUN ? '[dry] ' : ''}${task.taskType} ${task.id} → in=${tokensIn} out=${tokensOut}` +
          ` model=${model ?? '—'} cost=${cost !== undefined ? `${(cost / 100).toFixed(2)}元` : '—'}`,
      );
    }
  } finally {
    gateway.close();
    await prisma.$disconnect();
  }
  console.log(`完成：补记 ${filled} 条，网关无会话记录 ${missing} 条（未动）`);
  return 0;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
