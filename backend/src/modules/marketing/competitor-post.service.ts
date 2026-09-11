import { Injectable } from '@nestjs/common';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../auth/auth.types';

/** 同行内容数据服务（批次4）：人工录入（m02:edit ∪ approve）+ 爬虫批量 upsert（boss∪sys_admin，
 * 独立端点供爬虫脚本调用）+ 看板聚合（同行 vs 我们的内容台账并排）。
 * 红线口径变更（老板 2026-09-02 拍板）：允许爬取同行公开数据，不爬客户资料；
 * 爬虫为独立外挂脚本（scripts/competitor-crawler），本服务只收数据不做抓取。 */
@Injectable()
export class CompetitorPostService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 人工录入一条同行动态 */
  async create(
    actor: JwtPayload,
    dto: {
      account: string;
      title: string;
      publishedAt?: Date;
      likesCount?: number;
      commentsCount?: number;
      sharesCount?: number;
      activityType?: string;
      note?: string;
    },
  ) {
    const row = await this.prisma.competitorPost.create({
      data: { ...dto, source: 'manual', createdBy: actor.sub },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'competitor_post.created',
      objectType: 'competitor_post',
      objectId: row.id,
      after: { account: row.account, title: row.title },
    });
    return row;
  }

  /** 爬虫批量 upsert（同账号+标题视为同一条，更新互动数据与抓取时间） */
  async upsertFromCrawler(
    actor: JwtPayload,
    input: {
      items: Array<{
        account: string;
        title: string;
        publishedAt?: string;
        likesCount?: number;
        commentsCount?: number;
        sharesCount?: number;
      }>;
    },
  ): Promise<{ upserted: number }> {
    await this.assertBossOrAdmin(actor);
    let count = 0;
    for (const item of input.items) {
      const existing = await this.prisma.competitorPost.findFirst({
        where: { account: item.account, title: item.title },
      });
      if (existing) {
        await this.prisma.competitorPost.update({
          where: { id: existing.id },
          data: {
            ...(item.likesCount !== undefined ? { likesCount: item.likesCount } : {}),
            ...(item.commentsCount !== undefined ? { commentsCount: item.commentsCount } : {}),
            ...(item.sharesCount !== undefined ? { sharesCount: item.sharesCount } : {}),
            crawledAt: new Date(),
          },
        });
      } else {
        await this.prisma.competitorPost.create({
          data: {
            account: item.account,
            title: item.title,
            ...(item.publishedAt ? { publishedAt: new Date(item.publishedAt) } : {}),
            ...(item.likesCount !== undefined ? { likesCount: item.likesCount } : {}),
            ...(item.commentsCount !== undefined ? { commentsCount: item.commentsCount } : {}),
            ...(item.sharesCount !== undefined ? { sharesCount: item.sharesCount } : {}),
            source: 'crawler',
            crawledAt: new Date(),
          },
        });
      }
      count += 1;
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'competitor_post.crawled',
      objectType: 'competitor_post',
      after: { count },
    });
    return { upserted: count };
  }

  /** 看板聚合（m02:view）：按账号聚合同行互动量，与我方内容台账并排对比 */
  async board() {
    const [posts, ours] = await Promise.all([
      this.prisma.competitorPost.findMany({
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: { account: true, likesCount: true, commentsCount: true, title: true },
      }),
      this.prisma.contentRecord.findMany({
        select: { title: true, viewsCount: true, likesCount: true },
      }),
    ]);
    const byAccount = new Map<string, { posts: number; totalLikes: number; topLikes: number }>();
    for (const p of posts) {
      const row = byAccount.get(p.account) ?? { posts: 0, totalLikes: 0, topLikes: 0 };
      row.posts += 1;
      row.totalLikes += p.likesCount ?? 0;
      row.topLikes = Math.max(row.topLikes, p.likesCount ?? 0);
      byAccount.set(p.account, row);
    }
    return {
      competitors: [...byAccount.entries()]
        .map(([account, v]) => ({ account, ...v }))
        .sort((a, b) => b.totalLikes - a.totalLikes),
      ours: {
        posts: ours.length,
        totalLikes: ours.reduce((s, c) => s + (c.likesCount ?? 0), 0),
        topLikes: ours.reduce((m, c) => Math.max(m, c.likesCount ?? 0), 0),
      },
    };
  }

  private async assertBossOrAdmin(actor: JwtPayload): Promise<void> {
    const roles = await this.prisma.userRole.findMany({
      where: { userId: actor.sub },
      select: { role: { select: { code: true } } },
    });
    const codes = roles.map((r) => r.role.code);
    if (!codes.includes('boss') && !codes.includes('sys_admin')) {
      throw new AppException(ErrorCode.PERM_DENIED, '仅老板或系统管理员可写入爬虫数据');
    }
  }
}
