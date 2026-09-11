import { Injectable } from '@nestjs/common';
import type { KnowledgeItem, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { KnowledgeKind } from './knowledge.constants';
import type { KnowledgeStatus } from './knowledge.states';

/** 知识库列表过滤 */
export interface KnowledgeListFilters {
  kind?: KnowledgeKind;
  status?: KnowledgeStatus;
  keyword?: string;
}

/** 知识库数据访问（S08：controller 不直接调 Prisma） */
@Injectable()
export class KnowledgeRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** 创建知识条目（version=1, status=draft） */
  async create(
    data: Omit<Prisma.KnowledgeItemUncheckedCreateInput, 'id' | 'version' | 'status'> & {
      version?: number;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<KnowledgeItem> {
    const client = tx ?? this.prisma;
    return client.knowledgeItem.create({
      data: { ...data, version: data.version ?? 1, status: 'draft' },
    });
  }

  /** 按 ID 查询 */
  findById(id: string): Promise<KnowledgeItem | null> {
    return this.prisma.knowledgeItem.findUnique({ where: { id } });
  }

  /** 按 kind + key 查所有版本（version 降序） */
  findByKindAndKey(kind: string, key: string): Promise<KnowledgeItem[]> {
    return this.prisma.knowledgeItem.findMany({
      where: { kind, key },
      orderBy: { version: 'desc' },
    });
  }

  /** 查生效版本（status=active），支持按 kind 过滤 */
  findActive(kind?: string): Promise<KnowledgeItem[]> {
    return this.prisma.knowledgeItem.findMany({
      where: { status: 'active', ...(kind ? { kind } : {}) },
      orderBy: { kind: 'asc' },
    });
  }

  /** 查同键生效版本数（用于唯一性校验） */
  async countActiveByKindAndKey(kind: string, key: string): Promise<number> {
    return this.prisma.knowledgeItem.count({
      where: { kind, key, status: 'active' },
    });
  }

  /** 列表查询（kind/status/keyword 过滤） */
  async findMany(filters: KnowledgeListFilters): Promise<KnowledgeItem[]> {
    const where: Prisma.KnowledgeItemWhereInput = {};
    if (filters.kind) where.kind = filters.kind;
    if (filters.status) where.status = filters.status;
    if (filters.keyword) {
      where.OR = [
        { title: { contains: filters.keyword } },
        { content: { contains: filters.keyword } },
        { key: { contains: filters.keyword } },
      ];
    }
    return this.prisma.knowledgeItem.findMany({
      where,
      orderBy: [{ kind: 'asc' }, { key: 'asc' }, { version: 'desc' }],
    });
  }

  /** 更新字段 */
  update(
    id: string,
    data: Partial<Prisma.KnowledgeItemUncheckedUpdateInput>,
    tx?: Prisma.TransactionClient,
  ): Promise<KnowledgeItem> {
    const client = tx ?? this.prisma;
    return client.knowledgeItem.update({ where: { id }, data });
  }

  /** 条件状态迁移（防并发）：updateMany 返回 count 判定是否成功 */
  async transitionStatus(
    id: string,
    from: string,
    to: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? this.prisma;
    const result = await client.knowledgeItem.updateMany({
      where: { id, status: from },
      data: { status: to },
    });
    return result.count;
  }

  /** 事务包装 */
  async tx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn);
  }
}
