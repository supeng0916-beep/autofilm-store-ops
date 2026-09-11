/** persona 解析与映射（V1.5 Task1）：显式映射优先 > 角色兜底（boss>store_manager>sales_ops）> general；
 * 映射读写走 SystemMeta `agent.persona.map`，变更审计；非法映射值容错走兜底。 */
import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PersonaService } from '../src/modules/agent/persona.service';
import type { JwtPayload } from '../src/modules/auth/auth.types';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

const password = 'S3cure-Passw0rd!';

describe('PersonaService（V1.5）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let persona: PersonaService;
  const op: JwtPayload = { sub: 'op', username: 'op', type: 'access' };

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    persona = app.get(PersonaService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
  });
  afterAll(async () => {
    await prisma.systemMeta.deleteMany({ where: { key: 'agent.persona.map' } });
    await app.close();
  });

  async function mkUser(roles: string[]): Promise<string> {
    const username = uniqueUsername('ps');
    const user = await prisma.user.create({
      data: { username, passwordHash: await auth.hashPassword(password), displayName: username },
    });
    for (const code of roles) {
      const role = await prisma.role.findUniqueOrThrow({ where: { code } });
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    }
    return user.id;
  }

  it('角色兜底：boss→boss、store_manager→manager、sales_ops→sales、recorder→general、多角色取最高', async () => {
    expect(await persona.resolve(await mkUser(['boss']))).toBe('boss');
    expect(await persona.resolve(await mkUser(['store_manager', 'recorder']))).toBe('manager');
    expect(await persona.resolve(await mkUser(['sales_ops']))).toBe('sales');
    expect(await persona.resolve(await mkUser(['recorder']))).toBe('general');
    // 老板娘形态：sales_ops+store_manager+recorder 无映射时兜底 manager（踩空风险见 spec §7）
    expect(await persona.resolve(await mkUser(['sales_ops', 'store_manager', 'recorder']))).toBe(
      'manager',
    );
  });

  it('显式映射优先：多角色账号映射为 boss（老板娘场景）', async () => {
    const id = await mkUser(['sales_ops', 'store_manager', 'recorder']);
    await persona.setEntry(op, { userId: id, persona: 'boss' });
    expect(await persona.resolve(id)).toBe('boss');
    // 删除映射回落兜底
    await persona.setEntry(op, { userId: id, persona: null });
    expect(await persona.resolve(id)).toBe('manager');
  });

  it('非法映射值容错：走角色兜底不抛错', async () => {
    const id = await mkUser(['sales_ops']);
    await prisma.systemMeta.upsert({
      where: { key: 'agent.persona.map' },
      create: { key: 'agent.persona.map', value: JSON.stringify({ [id]: 'keeper' }) },
      update: { value: JSON.stringify({ [id]: 'keeper' }) },
    });
    expect(await persona.resolve(id)).toBe('sales');
  });

  it('setEntry 校验与审计：不存在/停用用户拒收、合法变更写 auditLog', async () => {
    const id = await mkUser(['store_manager']);
    await expect(
      persona.setEntry(op, { userId: 'nonexistent', persona: 'boss' }),
    ).rejects.toThrow();
    await persona.setEntry(op, { userId: id, persona: 'boss' });
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'agent.persona.changed', objectType: 'agent_persona', objectId: id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    // 停用账号拒收
    await prisma.user.update({ where: { id }, data: { disabled: true } });
    await expect(persona.setEntry(op, { userId: id, persona: 'manager' })).rejects.toThrow();
    await prisma.user.update({ where: { id }, data: { disabled: false } });
  });

  it('unmappedMultiRoleHints：持有 store_manager 的多角色账号且无显式映射 → 提示', async () => {
    const id = await mkUser(['sales_ops', 'store_manager', 'recorder']);
    const hints = await persona.unmappedMultiRoleHints();
    expect(hints.some((h) => h.userId === id && h.roles.includes('store_manager'))).toBe(true);
  });
});
