import { Injectable } from '@nestjs/common';
import type { User, UserRole } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

export type UserWithRoles = User & {
  userRoles: (UserRole & { role: { code: string; name: string } })[];
};

/** 系统账号数据访问（S08：controller 不直接调 Prisma） */
@Injectable()
export class SystemRepository {
  constructor(private readonly prisma: PrismaService) {}

  listUsers(): Promise<UserWithRoles[]> {
    return this.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      include: { userRoles: { include: { role: { select: { code: true, name: true } } } } },
    });
  }

  findById(id: string): Promise<UserWithRoles | null> {
    return this.prisma.user.findUnique({
      where: { id },
      include: { userRoles: { include: { role: { select: { code: true, name: true } } } } },
    });
  }

  findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { username } });
  }

  /** 建号 + 赋角色：同一事务内完成，任一步失败整体回滚，不产生无角色孤儿账号 */
  async createUserWithRoles(
    data: { username: string; displayName: string; passwordHash: string },
    roleCodes: string[],
  ): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data });
      const roles = await tx.role.findMany({ where: { code: { in: roleCodes } } });
      await tx.userRole.createMany({ data: roles.map((r) => ({ userId: user.id, roleId: r.id })) });
      return user;
    });
  }

  /** 角色整体替换：事务内先删后建，保证不出现半更新状态 */
  async replaceRoles(userId: string, roleCodes: string[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId } });
      const roles = await tx.role.findMany({ where: { code: { in: roleCodes } } });
      await tx.userRole.createMany({ data: roles.map((r) => ({ userId, roleId: r.id })) });
    });
  }

  setDisabled(id: string, disabled: boolean): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: { disabled } });
  }
}
