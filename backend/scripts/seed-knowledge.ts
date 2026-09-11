/** 作品集知识初始化入口：默认没有内置资料，直接退出，不连接数据库、后端或模型。
 * 如需知识管理演示，请通过页面手工录入虚构草稿；不要恢复真实资料到公开仓库。 */
import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { requireDbUrl } from './db-env';
import { KNOWLEDGE_SEED_ITEMS } from './seed-knowledge.data';

const API = process.env.WG_SEED_API_URL ?? 'http://127.0.0.1:8000';

interface KnowledgeItemRow {
  id: string;
  kind: string;
  key: string;
  status: string;
}

async function call(
  method: 'get' | 'post' | 'patch',
  url: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API}/api/v1${url}`, {
    method: method.toUpperCase(),
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function main(): Promise<number> {
  if (KNOWLEDGE_SEED_ITEMS.length === 0) {
    console.log('[作品集] 未包含门店知识，跳过初始化；可在知识库页面录入虚构草稿。');
    return 0;
  }

  const seedPassword = process.env.WG_SEED_PASSWORD?.trim();
  if (!seedPassword) {
    console.error('[失败] 缺少 WG_SEED_PASSWORD（backend/.env）');
    return 1;
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: requireDbUrl(process.env) }),
  });

  try {
    // 健康检查
    const health = await call('get', '/health', null).catch(() => null);
    if (!health || health.status >= 400) {
      console.error(`[失败] 后端未运行或不可达（${API}）；请先 make dev 或 npm run start`);
      return 1;
    }

    const login = async (username: string): Promise<string> => {
      const res = await call('post', '/auth/login', null, { username, password: seedPassword });
      // 登录/审批等 POST 端点未显式 @HttpCode，默认 201（与 eval.ts 同口径）
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(`登录失败 ${username}：${JSON.stringify(res.body)}`);
      }
      return (res.body as { accessToken: string }).accessToken;
    };
    const managerToken = await login('ph-store-manager'); // m06:edit 创建/发起生效
    const bossToken = await login('ph-boss'); // approval:decide 价格生效审批

    // 幂等：已有同 (kind,key) 即跳过；内容有变则 PATCH 生成新版本并重新生效（材料迭代可重跑）
    const existingRows = await prisma.knowledgeItem.findMany({
      where: { key: { in: KNOWLEDGE_SEED_ITEMS.map((i) => i.key) } },
      orderBy: { version: 'desc' },
    });
    const latestByKey = new Map<string, KnowledgeItemRow>();
    for (const row of existingRows) {
      const k = `${row.kind}:${row.key}`;
      if (!latestByKey.has(k)) latestByKey.set(k, row);
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const createdIds: string[] = [];

    for (const item of KNOWLEDGE_SEED_ITEMS) {
      const existingItem = latestByKey.get(`${item.kind}:${item.key}`);
      if (existingItem && existingItem.status === 'active') {
        // 取最新版本的 content/source 对比（Prisma 行上即该版本内容）
        const full = await prisma.knowledgeItem.findUnique({
          where: { id: existingItem.id },
          select: { content: true, source: true },
        });
        if (full?.content === item.content && full?.source === item.source) {
          skipped++;
          continue;
        }
        // 内容有变：编辑（生成新版本）→ 生效（价格走审批）
        const patch = await call('patch', `/knowledge/${existingItem.id}`, managerToken, {
          title: item.title,
          content: item.content,
          source: item.source,
          licensed: item.licensed,
        });
        if (patch.status !== 200) {
          console.error(`[失败] 编辑 ${item.key}：${JSON.stringify(patch.body)}`);
          return 1;
        }
        const newId = (patch.body as { id: string }).id;
        createdIds.push(newId);
        const act = await call('post', `/knowledge/${newId}/activate`, managerToken);
        if (act.status !== 200) {
          console.error(`[失败] 生效 ${item.key}：${JSON.stringify(act.body)}`);
          return 1;
        }
        const approvalId = (act.body as { approvalId?: string }).approvalId;
        if (approvalId) {
          const apr = await call('post', `/approvals/${approvalId}/approve`, bossToken, {
            confirmed: true,
            opinion: 'P4-06 基线材料更新（leader 材料迭代）',
          });
          if (apr.status !== 201) {
            console.error(`[失败] 价格审批 ${item.key}：${JSON.stringify(apr.body)}`);
            return 1;
          }
        }
        updated++;
        console.log(`[更新] ${item.kind} ${item.key}${approvalId ? '（价格审批通过）' : ''}`);
        continue;
      }
      if (existingItem) {
        skipped++; // 存在非 active 版本（如驳回中），不自动处理
        continue;
      }
      const res = await call('post', '/knowledge', managerToken, {
        kind: item.kind,
        key: item.key,
        title: item.title,
        content: item.content,
        source: item.source,
        licensed: item.licensed,
      });
      if (res.status !== 201) {
        console.error(`[失败] 创建 ${item.key}：${JSON.stringify(res.body)}`);
        return 1;
      }
      const id = (res.body as { id: string }).id;
      createdIds.push(id);

      const act = await call('post', `/knowledge/${id}/activate`, managerToken);
      if (act.status !== 200) {
        console.error(`[失败] 生效 ${item.key}：${JSON.stringify(act.body)}`);
        return 1;
      }
      // 价格类：activate 返回 {approvalId}，boss 审批后回调生效（P4-01 审批流）
      const approvalId = (act.body as { approvalId?: string }).approvalId;
      if (approvalId) {
        const apr = await call('post', `/approvals/${approvalId}/approve`, bossToken, {
          confirmed: true,
          opinion: 'P4-06 基线价格生效（leader 材料口径）',
        });
        if (apr.status !== 201) {
          console.error(`[失败] 价格审批 ${item.key}：${JSON.stringify(apr.body)}`);
          return 1;
        }
      }
      created++;
      console.log(`[ok] ${item.kind} ${item.key}${approvalId ? '（价格审批通过）' : ''}`);
    }

    // 向量就绪轮询：每个新条目至少 1 块（Embedding 未配置时全为 0，给出警告不失败）
    if (createdIds.length > 0) {
      console.log('== 等待向量化落库 ==');
      let ready = 0;
      for (let i = 0; i < 90; i++) {
        const rows = await prisma.knowledgeEmbedding.groupBy({
          by: ['itemId'],
          where: { itemId: { in: createdIds } },
        });
        ready = rows.length;
        if (ready >= createdIds.length) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const embeddedItems = ready;
      if (embeddedItems < createdIds.length) {
        console.warn(
          `[警告] 向量化未全部就绪：${embeddedItems}/${createdIds.length}（检查 WG_EMBEDDING_* 配置与网络）`,
        );
      } else {
        console.log(`[ok] 向量化就绪 ${embeddedItems}/${createdIds.length}`);
      }
    }

    // 汇总：各 kind 生效条数（全库口径，含此前已有）
    const summary = await prisma.knowledgeItem.groupBy({
      by: ['kind'],
      where: { status: 'active' },
      _count: { _all: true },
    });
    console.log('== 生效知识汇总（全库） ==');
    for (const row of summary.sort((a, b) => b._count._all - a._count._all)) {
      console.log(`  ${row.kind}: ${row._count._all} 条`);
    }
    console.log(`本次：新建+生效 ${created} 条，更新 ${updated} 条，跳过 ${skipped} 条`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

void main().then((code) => process.exit(code));
