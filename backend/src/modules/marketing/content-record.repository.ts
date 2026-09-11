import { Injectable } from '@nestjs/common';
import type { ContentRecord, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

/** 内容台账数据访问（批次2 任务3；S08：controller 不直接调 Prisma）。
 * 刻意不提供 delete——台账供复盘归因，只增与改（互动数据回填）。 */
@Injectable()
export class ContentRecordRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 列表：publishedAt desc，未登记发布日期的排最后（nulls last，复盘先看近期内容） */
  findMany(): Promise<ContentRecord[]> {
    return this.prisma.contentRecord.findMany({
      orderBy: { publishedAt: { sort: 'desc', nulls: 'last' } },
    });
  }

  findById(id: string): Promise<ContentRecord | null> {
    return this.prisma.contentRecord.findUnique({ where: { id } });
  }

  create(data: Prisma.ContentRecordUncheckedCreateInput): Promise<ContentRecord> {
    return this.prisma.contentRecord.create({ data });
  }

  update(id: string, data: Prisma.ContentRecordUpdateInput): Promise<ContentRecord> {
    return this.prisma.contentRecord.update({ where: { id }, data });
  }
}
