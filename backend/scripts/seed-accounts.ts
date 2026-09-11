/** 真人账号种子（v1.5 交付账号：demo-owner-a/demo-owner-b/demo-manager/demo-sales-a/demo-sales-b；八名施工
 * 师傅按已确认决策 C 不设登录账号——技师为资源实体，信息由店长/记录员代录）。
 * 口令策略：首次运行生成随机口令并落 `scripts/.accounts.local.json`（gitignore，S04）；
 * 之后重跑沿用同一文件——口令稳定，可随 deploy/package.sh 带到部署机保持一致。
 * 权威同步（2026-09-03，原"只补角色不移除"升级）：对 REAL_ACCOUNTS 列出的账号，
 * 重跑即把角色关联对齐声明集——删除未声明的角色关联、补齐声明的角色，口令不动。
 * 同步只作用于 REAL_ACCOUNTS 中的账号，占位账号/测试账号不受影响。
 * 用法：cd backend && npm run seed:accounts */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

import { requireDbUrl } from './db-env';
import { REAL_ACCOUNTS } from './seed-accounts.data';

const ACCOUNTS_FILE = join(__dirname, '.accounts.local.json');

/** 无歧义字符集（去 0/O/1/I/l），前缀 Wg- 便于识别归属 */
function genPassword(): string {
  const chars = '23456789abcdefghjkmnpqrstuvwxyz';
  const pick = (n: number) => [...randomBytes(n)].map((b) => chars[b % chars.length]).join('');
  return `Wg-${pick(4)}-${pick(4)}`;
}

function loadPasswords(): Record<string, string> {
  if (existsSync(ACCOUNTS_FILE)) {
    return JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8')) as Record<string, string>;
  }
  const generated = Object.fromEntries(REAL_ACCOUNTS.map((a) => [a.username, genPassword()]));
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(generated, null, 2) + '\n');
  console.log(`[生成] 口令文件 ${ACCOUNTS_FILE}（gitignore 已覆盖，勿提交）`);
  return generated;
}

async function main(): Promise<number> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: requireDbUrl(process.env) }),
  });
  const passwords = loadPasswords();
  try {
    const roleRows = await prisma.role.findMany({ select: { id: true, code: true } });
    const roleId = new Map(roleRows.map((r) => [r.code, r.id]));

    console.log('== 真人账号 ==');
    for (const acc of REAL_ACCOUNTS) {
      const missing = acc.roles.filter((r) => !roleId.has(r));
      if (missing.length > 0) {
        console.error(`[失败] 角色不存在：${missing.join(',')}（先运行 npm run seed 初始化角色）`);
        return 1;
      }
      const password = passwords[acc.username];
      if (!password) {
        console.error(`[失败] 口令文件缺 ${acc.username}，删除 ${ACCOUNTS_FILE} 后重跑`);
        return 1;
      }
      const existing = await prisma.user.findUnique({ where: { username: acc.username } });
      if (existing) {
        // 权威同步（2026-09-03）：角色关联与声明集对齐——先删未声明的，再补缺失的；口令不动。
        // 仅作用于 REAL_ACCOUNTS 列出的账号（占位/测试账号不在循环内，不受影响）。
        const declared = acc.roles.map((r) => roleId.get(r)!);
        const removed = await prisma.userRole.deleteMany({
          where: { userId: existing.id, roleId: { notIn: declared } },
        });
        for (const r of acc.roles) {
          await prisma.userRole
            .create({ data: { userId: existing.id, roleId: roleId.get(r)! } })
            .catch(() => undefined); // 已存在则跳过
        }
        const removedNote = removed.count > 0 ? `，移除未声明角色 ${removed.count} 条` : '';
        console.log(
          `[同步] ${acc.username}（${acc.displayName}）[${acc.roles.join('+')}]——角色已对齐声明${removedNote}，口令未改动`,
        );
        continue;
      }
      const user = await prisma.user.create({
        data: {
          username: acc.username,
          displayName: acc.displayName,
          passwordHash: await argon2.hash(password),
        },
      });
      for (const r of acc.roles) {
        await prisma.userRole.create({ data: { userId: user.id, roleId: roleId.get(r)! } });
      }
      console.log(
        `[创建] ${acc.username}（${acc.displayName}）[${acc.roles.join('+')}] ${acc.note}`,
      );
    }

    console.log('\n== 账号口令（本地文件保管，勿入对话截图/文档） ==');
    for (const acc of REAL_ACCOUNTS) {
      console.log(
        `  ${acc.displayName.padEnd(10)} ${acc.username.padEnd(14)} ${passwords[acc.username]}`,
      );
    }

    // 分派池配置（2026-08-21 门店实测修复）：assign.service 默认池=占位账号 ph-*，
    // 真人账号就位后写入真实分派名单，避免新导入客资被自动分派给无人登录的占位号
    //（销售队列看不到自己的新客资）。仅首次写入（update 空），不覆盖后续人工调整。
    const ASSIGN_DEFAULTS: Array<{ key: string; value: string }> = [
      {
        key: 'assign.pool.online',
        value: JSON.stringify(['demo-owner-b', 'demo-sales-a', 'demo-sales-b']),
      },
      {
        key: 'assign.pool.4s',
        value: JSON.stringify(['demo-owner-b', 'demo-sales-a', 'demo-sales-b']),
      },
      { key: 'assign.boss', value: JSON.stringify('demo-owner-a') },
    ];
    for (const m of ASSIGN_DEFAULTS) {
      await prisma.systemMeta.upsert({ where: { key: m.key }, update: {}, create: m });
    }
    console.log('[成功] 分派池已指向真人账号（首次写入；线上池/4S池/老板）');
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

void main().then((code) => process.exit(code));
