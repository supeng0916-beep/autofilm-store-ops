import { Injectable } from '@nestjs/common';
import type { User, UserRole } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

/** 用户数据访问：认证与账号查询（S08：controller 不直接调 Prisma） */
@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { username } });
  }

  findById(
    id: string,
  ): Promise<(User & { userRoles: (UserRole & { role: { code: string } })[] }) | null> {
    return this.prisma.user.findUnique({
      where: { id },
      include: { userRoles: { include: { role: { select: { code: true } } } } },
    });
  }

  updateAuthState(
    id: string,
    data: { failedAttempts?: number; lockedUntil?: Date | null },
  ): Promise<User> {
    return this.prisma.user.update({ where: { id }, data });
  }

  /** 改密落库（#11）：只更新哈希；会话令牌不作废，由前端保持登录态 */
  updatePasswordHash(id: string, passwordHash: string): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: { passwordHash } });
  }

  /** 批量 用户ID→显示名（2026-08-28 bug1：客资队列负责人列曾原样显示 cuid 内部 ID） */
  async findDisplayNamesByIds(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true },
    });
    return new Map(rows.map((u) => [u.id, u.displayName]));
  }

  /** 按显示名反查用户 ID（2026-08-28 bug1：负责人筛选改为按姓名；无匹配返回空数组，
   * 调用方据此短路为空结果——宁可空列表也不退回按原始 ID 匹配） */
  async findIdsByDisplayNameLike(name: string): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: { displayName: { contains: name, mode: 'insensitive' } },
      select: { id: true },
    });
    return rows.map((u) => u.id);
  }
}
