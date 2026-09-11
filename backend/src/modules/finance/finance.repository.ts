import { Injectable } from '@nestjs/common';
import type { FinanceEntry, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

/** 财务收支流水数据访问（批次2 任务2；S08：controller 不直接调 Prisma）。
 * append-only：刻意只有 create 与列表查询——不提供 update/delete（更正口径留痕走审计）。 */
@Injectable()
export class FinanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 列表：direction 可选 + occurredOn 时间窗（gte/lte 闭区间）；occurredOn desc 新流水在前 */
  findMany(filter: { direction?: string; from?: Date; to?: Date }): Promise<FinanceEntry[]> {
    return this.prisma.financeEntry.findMany({
      where: {
        ...(filter.direction ? { direction: filter.direction } : {}),
        ...(filter.from || filter.to
          ? {
              occurredOn: {
                ...(filter.from ? { gte: filter.from } : {}),
                ...(filter.to ? { lte: filter.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { occurredOn: 'desc' },
    });
  }

  create(data: Prisma.FinanceEntryUncheckedCreateInput): Promise<FinanceEntry> {
    return this.prisma.financeEntry.create({ data });
  }
}
