/** 数据库连通性检查：PostgreSQL 可连接且 pgvector 扩展可用。
 * 用法：cd backend && npm run check-db
 * 退出码：0=连接成功且pgvector就绪；1=连接失败；2=连接成功但pgvector未启用
 * Prisma 7 适配：不再支持裸 new PrismaClient()，需传 PrismaPg 驱动适配器；
 * 连接串经 dotenv 从 backend/.env 读取（命令行显式 WG_DATABASE_URL 优先）。 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { requireDbUrl } from './db-env';

/** Prisma 7 部分错误（如 ECONNREFUSED）message 为空、原因在 code 字段，兜底拼上 */
function describeDbError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  const msg = err.message.trim();
  return (
    [msg, typeof code === 'string' && code ? `(${code})` : ''].filter(Boolean).join(' ') ||
    '未知错误'
  );
}

async function main(): Promise<number> {
  let client: PrismaClient | undefined;
  try {
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: requireDbUrl(process.env) }),
    });
    const rows = await client.$queryRawUnsafe<Array<{ version: string }>>('select version()');
    console.log(`[成功] 已连接：${rows[0]?.version.split(',')[0] ?? 'unknown'}`);
    const ext = await client.$queryRawUnsafe<Array<{ extname: string }>>(
      "select extname from pg_extension where extname = 'vector'",
    );
    if (ext.length > 0) {
      console.log('[成功] pgvector 扩展已启用');
      return 0;
    }
    console.log('[警告] pgvector 未启用，请执行：CREATE EXTENSION vector;');
    return 2;
  } catch (err) {
    console.error(`[失败] 无法连接数据库：${describeDbError(err)}`);
    console.error('请确认：brew services start postgresql@16，且 WG_DATABASE_URL 正确');
    return 1;
  } finally {
    await client?.$disconnect();
  }
}

void main().then((code) => process.exit(code));
