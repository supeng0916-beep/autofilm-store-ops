import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreateCompetitorPostDto, CrawlerUpsertDto } from './dto/competitor-post.dto';
import { CompetitorPostService } from './competitor-post.service';
import { PrismaService } from '../../prisma/prisma.service';

/** 同行内容数据端点（批次4）：人工录入（m02:edit∪approve）、爬虫写入（boss∪sys_admin）、
 * 看板对比（m02:view）。爬虫抓取本身在独立脚本，本控制器只收数据。 */
@Controller('marketing')
export class CompetitorPostController {
  constructor(
    private readonly posts: CompetitorPostService,
    private readonly prisma: PrismaService,
  ) {}

  /** 人工录入一条同行动态 */
  @Post('competitor-posts')
  @RequirePermission('m02:edit', 'm02:approve')
  create(@Body() dto: CreateCompetitorPostDto, @CurrentUser() actor: JwtPayload) {
    return this.posts.create(actor, dto);
  }

  /** 爬虫批量 upsert（独立脚本调用；boss∪sys_admin 服务层硬校验） */
  @Post('competitor-posts/crawler')
  @HttpCode(HttpStatus.CREATED)
  crawlerUpsert(@Body() dto: CrawlerUpsertDto, @CurrentUser() actor: JwtPayload) {
    return this.posts.upsertFromCrawler(actor, dto);
  }

  /** 看板对比数据（m02:view） */
  @Get('competitor-board')
  @RequirePermission('m02:view')
  board() {
    return this.posts.board();
  }

  /** 近期同行动态列表（?account= 过滤） */
  @Get('competitor-posts')
  @RequirePermission('m02:view')
  list(@Query('account') account?: string) {
    return this.prisma.competitorPost.findMany({
      where: account ? { account } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
}
