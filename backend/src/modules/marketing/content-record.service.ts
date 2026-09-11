import { Injectable } from '@nestjs/common';
import type { ContentRecord } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { JwtPayload } from '../auth/auth.types';
import { ContentRecordRepository } from './content-record.repository';
import type { CreateContentRecordDto, UpdateContentRecordDto } from './dto/content-record.dto';

/** 内容台账服务（批次2 任务3，M02）：登记已发布内容与互动数据回填。
 * 归因口径：contentKey 与导入客资的 contentId 字段匹配（见 lead/import/row-schema.ts），
 * 复盘页据此归因——故归因键创建后不可改（更新 DTO 不接收），唯一性由数据库约束兜底。
 * 创建/更新均写审计留痕（S11 可追溯）。 */
@Injectable()
export class ContentRecordService {
  constructor(
    private readonly repo: ContentRecordRepository,
    private readonly audit: AuditService,
  ) {}

  list(): Promise<ContentRecord[]> {
    return this.repo.findMany();
  }

  /** 登记一条内容台账并写审计（content_record.created，after 含归因键/标题/成本快照）；
   * contentKey 撞唯一索引（P2002）→ 业务 409（先例 referral.service.create 写法）。 */
  async create(actor: JwtPayload, dto: CreateContentRecordDto): Promise<ContentRecord> {
    let record: ContentRecord;
    try {
      record = await this.repo.create({
        contentKey: dto.contentKey,
        title: dto.title,
        platform: dto.platform,
        publishedAt: dto.publishedAt,
        costFen: dto.costFen,
        viewsCount: dto.viewsCount,
        likesCount: dto.likesCount,
        commentsCount: dto.commentsCount,
        note: dto.note,
        createdBy: actor.sub,
      });
    } catch (err) {
      // contentKey 唯一索引冲突：该内容已登记 → 业务 409（不泄露数据库错误细节）。
      // 错误码选择：ErrorCode 无营销专属 409 码，按任务口径不新增码，取语义最近的
      // 系统段通用冲突码 CONFLICT（409，见 error-code.ts ERROR_STATUS 映射）。
      if (isUniqueConstraint(err)) {
        throw new AppException(ErrorCode.CONFLICT, '内容编号已存在');
      }
      throw err;
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'content_record.created',
      objectType: 'content_record',
      objectId: record.id,
      after: { contentKey: record.contentKey, title: record.title, costFen: record.costFen },
    });
    return record;
  }

  /** 回填互动数据/备注/成本并写审计（content_record.updated，before/after 仅含被改字段，
   * 口径同 asset.update）；归因键与标题不在更新面内（DTO 不接收）。不存在 → 404。 */
  async update(actor: JwtPayload, id: string, dto: UpdateContentRecordDto): Promise<ContentRecord> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new AppException(ErrorCode.NOT_FOUND, '内容台账不存在');

    const data: Partial<
      Pick<ContentRecord, 'viewsCount' | 'likesCount' | 'commentsCount' | 'costFen' | 'note'>
    > = {};
    if (dto.viewsCount !== undefined) data.viewsCount = dto.viewsCount;
    if (dto.likesCount !== undefined) data.likesCount = dto.likesCount;
    if (dto.commentsCount !== undefined) data.commentsCount = dto.commentsCount;
    if (dto.costFen !== undefined) data.costFen = dto.costFen;
    if (dto.note !== undefined) data.note = dto.note;

    const record = await this.repo.update(id, data);
    const keys = Object.keys(data) as Array<keyof typeof data>;
    const before = Object.fromEntries(keys.map((k) => [k, existing[k]]));
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'content_record.updated',
      objectType: 'content_record',
      objectId: id,
      before,
      after: data,
    });
    return record;
  }
}

/** Prisma 唯一约束冲突识别（P2002），不依赖 @prisma/client 具体错误类（先例 referral.service 同款） */
function isUniqueConstraint(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}
