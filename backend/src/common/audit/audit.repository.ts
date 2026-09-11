import { Injectable } from '@nestjs/common';
import type { AuditLog } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

/** 审计仓库：只增不改——刻意不提供 update/delete/upsert（P1-03 验收标准）。 */
@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: {
    actorId?: string;
    actorName?: string;
    action: string;
    objectType: string;
    objectId?: string;
    before?: unknown;
    after?: unknown;
    ip?: string;
  }): Promise<AuditLog> {
    return this.prisma.auditLog.create({
      data: {
        ...data,
        before: data.before === undefined ? undefined : (data.before as object),
        after: data.after === undefined ? undefined : (data.after as object),
      },
    });
  }

  findMany(where: { objectType: string; objectId?: string }): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
}
