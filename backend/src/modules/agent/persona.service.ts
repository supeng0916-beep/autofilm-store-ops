import { Injectable } from '@nestjs/common';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../auth/auth.types';
import { AGENT_PERSONAS, PERSONA_MAP_KEY, type AgentPersona } from './persona.types';

/** 角色兜底优先级（spec §3.2）：boss > store_manager > sales_ops；sys_admin/recorder → general */
const ROLE_FALLBACK: Array<{ code: string; persona: AgentPersona }> = [
  { code: 'boss', persona: 'boss' },
  { code: 'store_manager', persona: 'manager' },
  { code: 'sales_ops', persona: 'sales' },
];

/** persona 解析服务端唯一出口：SystemMeta 显式映射（老板娘等）> 角色兜底。
 * 每次 chat 现查不缓存（角色变更实时跟随，spec §5）。 */
@Injectable()
export class PersonaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async resolve(userId: string): Promise<AgentPersona> {
    const map = await this.readMap();
    const hit = map[userId];
    if (hit) return hit;
    const roles = await this.prisma.userRole.findMany({
      where: { userId },
      select: { role: { select: { code: true } } },
    });
    const codes = new Set(roles.map((r) => r.role.code));
    return ROLE_FALLBACK.find((r) => codes.has(r.code))?.persona ?? 'general';
  }

  async readMap(): Promise<Record<string, AgentPersona>> {
    const meta = await this.prisma.systemMeta.findUnique({ where: { key: PERSONA_MAP_KEY } });
    if (!meta) return {};
    try {
      const raw = JSON.parse(meta.value) as Record<string, unknown>;
      const out: Record<string, AgentPersona> = {};
      for (const [userId, persona] of Object.entries(raw)) {
        if ((AGENT_PERSONAS as readonly string[]).includes(persona as string)) {
          out[userId] = persona as AgentPersona;
        }
      }
      return out;
    } catch {
      return {}; // 非法 JSON 容错：视为未配置（spec §3.2 第 3 条）
    }
  }

  /** persona-map 端点门禁（spec §3.2）：boss ∪ sys_admin 角色——服务层硬校验（沿 ai-cost
   * setDailyOverride 先例：system:manage 权限点仅 sys_admin 持有（技术特权不授老板，
   * permissions.ts 口径），而 persona 映射是业务配置必须老板能改，故按角色而非权限点判定）。 */
  async assertBossOrAdmin(actor: JwtPayload): Promise<void> {
    const roles = await this.prisma.userRole.findMany({
      where: { userId: actor.sub },
      select: { role: { select: { code: true } } },
    });
    const codes = roles.map((r) => r.role.code);
    if (!codes.includes('boss') && !codes.includes('sys_admin')) {
      throw new AppException(ErrorCode.PERM_DENIED, '仅老板或系统管理员可配置助手技能包');
    }
  }

  /** 单条映射 set/del（persona=null 删除），目标用户校验后整体回写；变更审计（spec §3.2） */
  async setEntry(
    actor: JwtPayload,
    entry: { userId: string; persona: AgentPersona | null },
  ): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: entry.userId, disabled: false },
      select: { id: true },
    });
    if (!user) {
      throw new AppException(ErrorCode.NOT_FOUND, '用户不存在或已停用');
    }
    const before = await this.readMap();
    const after = { ...before };
    if (entry.persona === null) delete after[entry.userId];
    else after[entry.userId] = entry.persona;
    await this.prisma.systemMeta.upsert({
      where: { key: PERSONA_MAP_KEY },
      create: { key: PERSONA_MAP_KEY, value: JSON.stringify(after) },
      update: { value: JSON.stringify(after) },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'agent.persona.changed',
      objectType: 'agent_persona',
      objectId: entry.userId,
      before: { persona: before[entry.userId] ?? null },
      after: { persona: entry.persona },
    });
  }

  /** 踩空提示（spec §7）：持有 store_manager 的多角色账号且无显式映射（老板娘形态兜底会缺跟进区块） */
  async unmappedMultiRoleHints(): Promise<
    Array<{ userId: string; username: string; roles: string[] }>
  > {
    const map = await this.readMap();
    const rows = await this.prisma.userRole.findMany({
      where: { role: { code: { in: ['boss', 'store_manager', 'sales_ops'] } } },
      select: {
        userId: true,
        user: { select: { username: true, disabled: true } },
        role: { select: { code: true } },
      },
    });
    const byUser = new Map<string, { username: string; roles: string[] }>();
    for (const r of rows) {
      if (r.user.disabled) continue;
      const cur = byUser.get(r.userId) ?? { username: r.user.username, roles: [] };
      cur.roles.push(r.role.code);
      byUser.set(r.userId, cur);
    }
    return [...byUser.entries()]
      .filter(
        ([userId, { roles }]) =>
          !map[userId] && roles.length >= 2 && roles.includes('store_manager'),
      )
      .map(([userId, { username, roles }]) => ({ userId, username, roles }));
  }
}
