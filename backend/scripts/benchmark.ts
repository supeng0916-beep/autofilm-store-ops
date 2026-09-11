/** P6-05 性能成本基准（任务书 §7 成本与性能）：一键复跑。
 * 性能：对运行中的后端（默认 :8000）打代表端点 N 次，报告 p50/p95/max（进程外 HTTP，含完整鉴权/校验/DB 路径）
 * 成本：直查 dev 库 ai_tasks 聚合（任务数/token/成本，按日与按 skill）
 * 存储：pg 库尺寸/核心表尺寸 + uploads 目录
 * 用法（backend 目录，后端 dev 运行中）：npm run bench
 * 产物：docs/acceptance/P6-05-benchmark.json（报告引用其数据） */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { requireDbUrl } from './db-env';

const API = process.env.WG_EVAL_API_URL ?? 'http://127.0.0.1:8000';
const N = Number(process.env.WG_BENCH_N ?? 200);
const OUT_PATH = join(__dirname, '..', '..', 'docs', 'acceptance', 'P6-05-benchmark.json');

interface Sample {
  endpoint: string;
  n: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  errorCount: number;
}

async function call(
  method: 'get' | 'post',
  url: string,
  token: string | null,
  body?: unknown,
): Promise<number> {
  const res = await fetch(`${API}/api/v1${url}`, {
    method: method.toUpperCase(),
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.status;
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function bench(endpoint: string, fn: () => Promise<number>): Promise<Sample> {
  const times: number[] = [];
  let errorCount = 0;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const status = await fn();
    times.push(performance.now() - t0);
    if (status >= 400) errorCount += 1;
  }
  times.sort((a, b) => a - b);
  return {
    endpoint,
    n: N,
    p50Ms: Math.round(pct(times, 50)),
    p95Ms: Math.round(pct(times, 95)),
    maxMs: Math.round(times[times.length - 1] ?? 0),
    errorCount,
  };
}

async function main(): Promise<void> {
  const seedPassword = process.env.WG_SEED_PASSWORD?.trim();
  if (!seedPassword) throw new Error('缺少 WG_SEED_PASSWORD（请先 npm run seed）');

  const login = async (username: string): Promise<string> => {
    const res = await fetch(`${API}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: seedPassword }),
    });
    if (!res.ok) throw new Error(`登录 ${username} 失败：后端是否运行中？`);
    return ((await res.json()) as { accessToken: string }).accessToken;
  };
  const bossToken = await login('ph-boss');
  const salesToken = await login('ph-sales-ops');

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: requireDbUrl(process.env) }),
  });

  // 一个销售名下的存量客资作为详情/列表样本
  const salesUser = await prisma.user.findUniqueOrThrow({ where: { username: 'ph-sales-ops' } });
  const sampleLead = await prisma.lead.findFirst({
    where: { ownerUserId: salesUser.id },
    orderBy: { createdAt: 'desc' },
  });

  const samples: Sample[] = [];
  console.log(`== 性能基准：每端点 ${N} 次（${API}）==`);
  samples.push(
    await bench('POST /auth/login（argon2 校验）', () =>
      call('post', '/auth/login', null, { username: 'ph-boss', password: seedPassword }),
    ),
  );
  samples.push(await bench('GET /leads（列表）', () => call('get', '/leads', bossToken)));
  if (sampleLead) {
    samples.push(
      await bench('GET /leads/:id（详情）', () =>
        call('get', `/leads/${sampleLead.id}`, salesToken),
      ),
    );
  }
  samples.push(
    await bench('POST /leads/import/dispatch（单条导入+解析+去重锁）', () =>
      call('post', '/leads/import/dispatch', bossToken, {
        rawTexts: [
          [
            `派发NO：BENCH-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
            '门店：AutoFilm Demo',
            '日期：2026-08-17 12:00',
            `电话：139${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 90) + 10)}`,
            '车型：宝马X5',
            '需求：隔热膜',
          ].join('\n'),
        ],
      }),
    ),
  );
  samples.push(
    await bench('GET /appointments（列表）', () => call('get', '/appointments', bossToken)),
  );
  samples.push(
    await bench('GET /appointments/conflict-check（档期预检）', () =>
      call(
        'get',
        `/appointments/conflict-check?workbench=BENCH&startAt=${encodeURIComponent(
          new Date(Date.UTC(2026, 11, 20, 2)).toISOString(),
        )}&endAt=${encodeURIComponent(new Date(Date.UTC(2026, 11, 20, 5)).toISOString())}`,
        bossToken,
      ),
    ),
  );
  samples.push(
    await bench('GET /approvals?status=pending（审批队列）', () =>
      call('get', '/approvals?status=pending', bossToken),
    ),
  );
  samples.push(
    await bench('GET /knowledge（知识列表）', () => call('get', '/knowledge', bossToken)),
  );

  for (const s of samples) {
    console.log(
      `${s.endpoint}: p50=${s.p50Ms}ms p95=${s.p95Ms}ms max=${s.maxMs}ms 错误${s.errorCount}/${s.n}`,
    );
  }

  // ── 成本聚合（dev 库累计）──
  const [totals] = await prisma.$queryRawUnsafe<
    Array<{
      tasks: bigint;
      tokens_in: bigint | null;
      tokens_out: bigint | null;
      cost_fen: bigint | null;
    }>
  >(
    `SELECT count(*) AS tasks, sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out,
       sum(cost_estimate_fen) AS cost_fen FROM ai_tasks`,
  );
  const byType = await prisma.$queryRawUnsafe<
    Array<{ task_type: string; tasks: bigint; tokens: bigint | null; avg_latency: number | null }>
  >(
    `SELECT task_type, count(*) AS tasks, COALESCE(sum(tokens_in+tokens_out),0) AS tokens,
       avg(EXTRACT(EPOCH FROM (COALESCE(finished_at, callback_at, updated_at) - created_at))*1000) AS avg_latency
     FROM ai_tasks GROUP BY task_type ORDER BY tasks DESC`,
  );
  const byDay = await prisma.$queryRawUnsafe<
    Array<{ day: string; tasks: bigint; tokens: bigint | null; cost_fen: bigint | null }>
  >(
    `SELECT to_char(created_at AT TIME ZONE 'utc', 'YYYY-MM-DD') AS day, count(*) AS tasks,
       COALESCE(sum(tokens_in+tokens_out),0) AS tokens, sum(cost_estimate_fen) AS cost_fen
     FROM ai_tasks GROUP BY 1 ORDER BY 1 DESC LIMIT 7`,
  );

  // ── 存储 ──
  const [dbSize] = await prisma.$queryRawUnsafe<Array<{ size: string }>>(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS size`,
  );
  const tableSizes = await prisma.$queryRawUnsafe<
    Array<{ relname: string; size: string; rows: bigint }>
  >(
    `SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS size, n_live_tup AS rows
     FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10`,
  );
  const uploadsDir = join(__dirname, '..', 'uploads');
  let uploadsBytes = 0;
  if (existsSync(uploadsDir)) {
    uploadsBytes =
      Number(execFileSync('/usr/bin/du', ['-sk', uploadsDir]).toString().split('\t')[0]) * 1024;
  }

  const payload = {
    meta: {
      date: new Date().toISOString(),
      api: API,
      rounds: N,
      machine: {
        platform: `${os.platform()} ${os.arch()}`,
        cpus: `${os.cpus().length}× ${os.cpus()[0]?.model ?? ''}`.trim(),
        memGB: Math.round(os.totalmem() / 1024 ** 3),
        node: process.version,
      },
      note: '进程外 HTTP 循环（含鉴权/Zod 校验/DB 全路径）；AI 模型端到端延迟见 P6-02 评测基线 per-case latencyMs',
    },
    latency: samples,
    cost: {
      totals: {
        tasks: Number(totals?.tasks ?? 0),
        tokensIn: Number(totals?.tokens_in ?? 0),
        tokensOut: Number(totals?.tokens_out ?? 0),
        costFen: Number(totals?.cost_fen ?? 0),
      },
      byType: byType.map((r) => ({
        taskType: r.task_type,
        tasks: Number(r.tasks),
        tokens: Number(r.tokens ?? 0),
        avgLatencyMs: Math.round(Number(r.avg_latency ?? 0)),
      })),
      byDay: byDay.map((r) => ({
        day: r.day,
        tasks: Number(r.tasks),
        tokens: Number(r.tokens ?? 0),
        costFen: Number(r.cost_fen ?? 0),
      })),
    },
    storage: {
      dbSize: dbSize?.size,
      topTables: tableSizes.map((t) => ({
        table: t.relname,
        size: t.size,
        rows: Number(t.rows),
      })),
      uploadsBytes,
    },
  };

  await prisma.$disconnect();
  mkdirSync(join(OUT_PATH, '..'), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`产物：${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
