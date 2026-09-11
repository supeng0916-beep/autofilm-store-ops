/** 种子数据：5 角色 + 5 占位账号（开业前换真人，docs/dev-setup.md）。
 * 幂等：按 code/username upsert，不覆盖已有口令。
 * 用法：cd backend && npm run seed（或 make seed） */
import 'dotenv/config';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { requireDbUrl } from './db-env';

const ROLES = [
  { code: 'boss', name: '老板', description: '经营决策、关键机会接管、毛利与产能全局' },
  {
    code: 'store_manager',
    name: '店长',
    description: '门店运营：预约排期确认、接管执行、质检复检',
  },
  { code: 'sales_ops', name: '销售/运营', description: '客资跟进、消息草稿、内容任务' },
  { code: 'recorder', name: '施工记录员', description: '施工信息电脑端录入（技师不设账号）' },
  { code: 'sys_admin', name: '系统管理员', description: '配置、账号、集成、监控、备份' },
] as const;

const ACCOUNTS = [
  { username: 'ph-boss', displayName: '老板（占位）', role: 'boss' },
  { username: 'ph-store-manager', displayName: '店长（占位）', role: 'store_manager' },
  { username: 'ph-sales-ops', displayName: '销售/运营（占位）', role: 'sales_ops' },
  { username: 'ph-recorder', displayName: '施工记录员（占位）', role: 'recorder' },
  { username: 'ph-sys-admin', displayName: '系统管理员（占位）', role: 'sys_admin' },
] as const;

async function main(): Promise<number> {
  const seedPassword = process.env.WG_SEED_PASSWORD?.trim();
  if (!seedPassword) {
    console.error('[失败] 缺少 WG_SEED_PASSWORD（占位账号初始口令），请在 backend/.env 配置');
    return 1;
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: requireDbUrl(process.env) }),
  });
  try {
    for (const role of ROLES) {
      await prisma.role.upsert({ where: { code: role.code }, update: {}, create: role });
    }
    const passwordHash = await argon2.hash(seedPassword);
    for (const acc of ACCOUNTS) {
      const role = await prisma.role.findUniqueOrThrow({ where: { code: acc.role } });
      const user = await prisma.user.upsert({
        where: { username: acc.username },
        update: {},
        create: { username: acc.username, displayName: acc.displayName, passwordHash },
      });
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: user.id, roleId: role.id } },
        update: {},
        create: { userId: user.id, roleId: role.id },
      });
    }
    console.log('[成功] 种子完成：5 角色 + 5 占位账号（ph-*），口令取 WG_SEED_PASSWORD');
    return 0;
  } catch (err) {
    console.error(`[失败] 种子执行出错：${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main().then((code) => process.exit(code));
