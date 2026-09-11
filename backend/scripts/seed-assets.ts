/** 报价图入素材库（2026-08-19 落地决策 #9）：仓库根 `报价图/` 全量上传，
 * 不识图直接落库——kind=quote_image、licensed=true（报价图=门店对外成交口径，可展示）、
 * 标题=文件名（去扩展名）。
 * 模式：与 seed-knowledge.ts 一致——HTTP multipart 打真实后端（上传走 m06:edit 业务流），
 *       Prisma 直查仅用于幂等判断（同 kind+title 已存在即跳过）。
 * 前置：后端 dev 运行（:8000）、backend/.env 配置 WG_SEED_PASSWORD（ph-store-manager）。
 * 用法（backend 目录）：npm run seed:assets
 * 幂等：重复运行只补缺，已入库同名素材不动。 */
import 'dotenv/config';

import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { requireDbUrl } from './db-env';

const API = process.env.WG_SEED_API_URL ?? 'http://127.0.0.1:8000';
/** 报价图目录：仓库根 报价图/（2026-08-19 leader 确认位置，不在 门店知识源/ 下） */
const QUOTE_DIR = resolve(process.cwd(), '..', '报价图');

/** 素材上传仅收 jpg/png/webp/pdf（后端 fileFilter 同口径） */
const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`登录失败 ${username}：${await res.text()}`);
  }
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function main(): Promise<number> {
  const seedPassword = process.env.WG_SEED_PASSWORD?.trim();
  if (!seedPassword) {
    console.error('[失败] 缺少 WG_SEED_PASSWORD（backend/.env）');
    return 1;
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: requireDbUrl(process.env) }),
  });

  try {
    const health = await fetch(`${API}/api/v1/health`).catch(() => null);
    if (!health || !health.ok) {
      console.error(`[失败] 后端未运行或不可达（${API}）；请先 make dev 或 npm run start`);
      return 1;
    }

    const managerToken = await login('ph-store-manager', seedPassword); // m06:edit 可上传

    const files = (await readdir(QUOTE_DIR)).filter((f) => MIME_BY_EXT[extname(f).toLowerCase()]);
    if (files.length === 0) {
      console.warn(`[警告] ${QUOTE_DIR} 下无可上传图片（jpg/png/webp/pdf）`);
      return 0;
    }

    let created = 0;
    let skipped = 0;
    for (const file of files.sort()) {
      const title = basename(file, extname(file));
      // 幂等：同 kind+title 已存在即跳过（标题=文件名，重复运行不重复入库）
      const existing = await prisma.asset.findFirst({ where: { kind: 'quote_image', title } });
      if (existing) {
        skipped++;
        console.log(`[跳过] ${title}（已存在 id=${existing.id}）`);
        continue;
      }

      const buf = await readFile(join(QUOTE_DIR, file));
      const form = new FormData();
      form.append('kind', 'quote_image');
      form.append('title', title);
      form.append('licensed', 'true'); // 报价图可对外展示（#9 口径）
      form.append('source', '报价图（leader 2026-08-19 #9 入库）');
      form.append(
        'file',
        new Blob([buf], { type: MIME_BY_EXT[extname(file).toLowerCase()] }),
        file,
      );

      const res = await fetch(`${API}/api/v1/assets`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerToken}` },
        body: form,
      });
      if (res.status !== 201) {
        console.error(`[失败] 上传 ${file}：HTTP ${res.status} ${await res.text()}`);
        return 1;
      }
      const asset = (await res.json()) as { id: string };
      created++;
      console.log(`[ok] quote_image ${title}（id=${asset.id}，licensed=true）`);
    }

    const total = await prisma.asset.count({ where: { kind: 'quote_image' } });
    console.log(`本次：上传 ${created} 条，跳过 ${skipped} 条；素材库 quote_image 共 ${total} 条`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

void main().then((code) => process.exit(code));
