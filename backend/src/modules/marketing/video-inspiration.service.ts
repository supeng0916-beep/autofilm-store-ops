import { Injectable } from '@nestjs/common';
import type { VideoInspiration } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../auth/auth.types';
import type {
  CreateVideoInspirationDto,
  ListVideoInspirationsQueryDto,
  UpdateVideoInspirationDto,
} from './dto/video-inspiration.dto';

/** 注入文案生成（批次B Task 2）的参考条目：紧凑投影，只带拆解必需字段——
 * note/sourceUrl/createdBy 等人工与内部字段不进提示词 */
export interface InspirationContextItem {
  platform: string;
  title: string;
  hookText: string;
  structure: string;
  rhythm: string | null;
  metrics: string | null;
  tags: string[];
  isPeer: boolean;
}

/** 排序纯函数的入参最小形状（tags/title 参与匹配，createdAt 定序） */
interface InspirationRankRow {
  title: string;
  tags: string[];
  createdAt: Date;
}

/** 支柱关键词提取：支柱是账号定位里的长串（如「产品科普（膜的种类/真假鉴别）」），
 * 按中英文分隔符拆成关键词集合；过短的碎片（<2 字）噪音大，不作为关键词 */
function extractPillarKeywords(pillars: readonly string[]): Set<string> {
  const keywords = new Set<string>();
  for (const pillar of pillars) {
    for (const raw of pillar.split(/[\s()[\]{}（）【】·、，,;；:：/／|｜\-—]+/)) {
      const word = raw.trim().toLowerCase();
      if (word.length >= 2) keywords.add(word);
    }
  }
  return keywords;
}

/** 标签与支柱关键词匹配：等值或双向子串（标签「避坑」⊂关键词「行业揭秘避坑」，
 * 标签「贴膜内幕怎么讲」⊃关键词「贴膜内幕」）；单字标签不参与（噪音大） */
function tagMatchesPillar(tag: string, keywords: ReadonlySet<string>): boolean {
  const t = tag.trim().toLowerCase();
  if (t.length < 2) return false;
  for (const k of keywords) {
    if (k === t || k.includes(t) || t.includes(k)) return true;
  }
  return false;
}

/** 灵感检索排序（纯函数，无 DB 可直接单测）：tags 与支柱关键词交集优先、
 * title contains 提示词兜底。
 * - 交集组在前：按命中标签数降序，同数按 createdAt 降序（新爆款优先）；
 * - 兜底组在后：无交集但标题含提示词（无提示词则无兜底）；
 * - 两组之外（无交集且标题不命中）不入选——宁缺毋滥，避免无关参考污染提示词。
 * 返回前 limit 条（缺省 3，提示词长度上限内）。 */
export function pickInspirationsForContext<T extends InspirationRankRow>(
  rows: readonly T[],
  pillars: readonly string[],
  keywordHint?: string,
  limit = 3,
): T[] {
  if (rows.length === 0 || limit <= 0) return [];
  const keywords = extractPillarKeywords(pillars);
  const hint = keywordHint?.trim().toLowerCase() ?? '';

  const tagged: Array<{ row: T; hits: number }> = [];
  const titleHit: T[] = [];
  for (const row of rows) {
    const hits = row.tags.filter((tag) => tagMatchesPillar(tag, keywords)).length;
    if (hits > 0) tagged.push({ row, hits });
    else if (hint && row.title.toLowerCase().includes(hint)) titleHit.push(row);
  }
  tagged.sort((a, b) => b.hits - a.hits || b.row.createdAt.getTime() - a.row.createdAt.getTime());
  titleHit.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return [...tagged, ...titleHit].slice(0, limit).map((s) => ('row' in s ? s.row : s));
}

/** 灵感库服务（M02 批次B）：爆款参考沉淀——人工录入/浏览/归档 + 供文案生成检索。
 * 创建/更新均写审计留痕；拆解字段创建后不可改（更新面仅 note/status/tags，
 * 改拆解=对不上原视频，应重新登记）。T4 自动扫描配套：候选采纳/忽略
 * （candidate→active/archived，均写审计）。 */
@Injectable()
export class VideoInspirationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 列表（浏览找参考）：keyword 命中标题或钩子、platform 精确、isPeer 布尔过滤；
   * status 精确筛选（candidate=自动扫描候选）；不筛时 active 优先、candidate 次之、
   * archived 沉底（归档≠删除，仍可翻查），组内 createdAt 倒序 */
  async list(query: ListVideoInspirationsQueryDto): Promise<VideoInspiration[]> {
    const rows = await this.prisma.videoInspiration.findMany({
      where: {
        ...(query.keyword
          ? {
              OR: [
                { title: { contains: query.keyword, mode: 'insensitive' } },
                { hookText: { contains: query.keyword, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(query.platform ? { platform: query.platform } : {}),
        ...(query.isPeer === undefined ? {} : { isPeer: query.isPeer }),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    // status 排序不依赖字典序巧合，显式分层：active（在用）→ candidate（待处理）→ archived 沉底
    const rank = (status: string) => (status === 'archived' ? 2 : status === 'candidate' ? 1 : 0);
    return rows.sort((a, b) => rank(a.status) - rank(b.status));
  }

  /** 录入一条爆款参考并写审计（video_inspiration.created） */
  async create(actor: JwtPayload, dto: CreateVideoInspirationDto): Promise<VideoInspiration> {
    const row = await this.prisma.videoInspiration.create({
      data: {
        platform: dto.platform,
        title: dto.title,
        hookText: dto.hookText,
        structure: dto.structure,
        rhythm: dto.rhythm,
        metrics: dto.metrics,
        tags: dto.tags,
        isPeer: dto.isPeer,
        sourceUrl: dto.sourceUrl,
        note: dto.note,
        createdBy: actor.sub,
      },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'video_inspiration.created',
      objectType: 'video_inspiration',
      objectId: row.id,
      after: { platform: row.platform, title: row.title, tags: row.tags },
    });
    return row;
  }

  /** 更新备注/状态/标签并写审计（video_inspiration.updated，before/after 仅含被改字段）。
   * 不存在 → 404 */
  async update(
    actor: JwtPayload,
    id: string,
    dto: UpdateVideoInspirationDto,
  ): Promise<VideoInspiration> {
    const existing = await this.prisma.videoInspiration.findUnique({ where: { id } });
    if (!existing) throw new AppException(ErrorCode.NOT_FOUND, '灵感条目不存在');

    const data: Partial<Pick<VideoInspiration, 'note' | 'status' | 'tags'>> = {};
    if (dto.note !== undefined) data.note = dto.note;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.tags !== undefined) data.tags = dto.tags;

    const row = await this.prisma.videoInspiration.update({ where: { id }, data });
    const before = Object.fromEntries(
      (Object.keys(data) as Array<keyof typeof data>).map((k) => [k, existing[k]]),
    );
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'video_inspiration.updated',
      objectType: 'video_inspiration',
      objectId: id,
      before,
      after: data,
    });
    return row;
  }

  /** 采纳候选（T4 自动扫描配套）：candidate → active——自动扫描只做建议，
   * 人点头了才进正式灵感库（参与 AI 上下文注入）。仅 candidate 可操作，
   * 其余状态 409（终态防重口径同回访/受理先例）；不存在 404 */
  async adoptCandidate(actor: JwtPayload, id: string): Promise<VideoInspiration> {
    const existing = await this.prisma.videoInspiration.findUnique({ where: { id } });
    if (!existing) throw new AppException(ErrorCode.NOT_FOUND, '灵感条目不存在');
    if (existing.status !== 'candidate') {
      throw new AppException(ErrorCode.CONFLICT, '仅候选状态可采纳');
    }
    const row = await this.prisma.videoInspiration.update({
      where: { id },
      data: { status: 'active' },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'video_inspiration.adopted',
      objectType: 'video_inspiration',
      objectId: id,
      before: { status: 'candidate' },
      after: { status: 'active' },
    });
    return row;
  }

  /** 忽略候选（T4 自动扫描配套）：candidate → archived——不采纳也不留待办，
   * 归档保留可翻查（与人工归档同一终态）。仅 candidate 可操作，其余 409 */
  async dismissCandidate(actor: JwtPayload, id: string): Promise<VideoInspiration> {
    const existing = await this.prisma.videoInspiration.findUnique({ where: { id } });
    if (!existing) throw new AppException(ErrorCode.NOT_FOUND, '灵感条目不存在');
    if (existing.status !== 'candidate') {
      throw new AppException(ErrorCode.CONFLICT, '仅候选状态可忽略');
    }
    const row = await this.prisma.videoInspiration.update({
      where: { id },
      data: { status: 'archived' },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'video_inspiration.dismissed',
      objectType: 'video_inspiration',
      objectId: id,
      before: { status: 'candidate' },
      after: { status: 'archived' },
    });
    return row;
  }

  /** 供文案生成（批次B Task 2）检索参考：只取 active（归档不注入提示词），
   * 排序逻辑见 pickInspirationsForContext（纯函数，独立单测覆盖） */
  async searchForContext(
    pillars: readonly string[],
    keywordHint?: string,
    limit = 3,
  ): Promise<InspirationContextItem[]> {
    const rows = await this.prisma.videoInspiration.findMany({
      where: { status: 'active' },
      select: {
        platform: true,
        title: true,
        hookText: true,
        structure: true,
        rhythm: true,
        metrics: true,
        tags: true,
        isPeer: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    // 显式投影成注入条目（剥离 createdAt 排序辅助字段）
    return pickInspirationsForContext(rows, pillars, keywordHint, limit).map((row) => ({
      platform: row.platform,
      title: row.title,
      hookText: row.hookText,
      structure: row.structure,
      rhythm: row.rhythm,
      metrics: row.metrics,
      tags: row.tags,
      isPeer: row.isPeer,
    }));
  }
}
