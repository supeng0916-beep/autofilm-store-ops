import { Injectable } from '@nestjs/common';
import type { FinanceEntry } from '@prisma/client';

import { AuditService } from '../../common/audit';
import type { JwtPayload } from '../auth/auth.types';
import type { CreateFinanceEntryDto, ListFinanceQueryDto } from './dto/finance.dto';
import { FinanceRepository } from './finance.repository';

/** 财务收支流水服务（批次2 任务2，M10）：append-only 登记——只创建与列表，不允许修改。
 * 分类与 direction 的联动校验在 DTO 层完成（superRefine）；每笔创建写审计留痕（S11 可追溯）。 */
@Injectable()
export class FinanceService {
  constructor(
    private readonly repo: FinanceRepository,
    private readonly audit: AuditService,
  ) {}

  list(query: ListFinanceQueryDto): Promise<FinanceEntry[]> {
    return this.repo.findMany({
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
    });
  }

  /** 登记一笔流水并写审计（finance_entry.created，after 含方向/分类/金额快照） */
  async create(actor: JwtPayload, dto: CreateFinanceEntryDto): Promise<FinanceEntry> {
    const entry = await this.repo.create({
      direction: dto.direction,
      category: dto.category,
      amountFen: dto.amountFen,
      occurredOn: dto.occurredOn,
      remark: dto.remark,
      leadId: dto.leadId,
      orderConfirmationId: dto.orderConfirmationId,
      createdBy: actor.sub,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'finance_entry.created',
      objectType: 'finance_entry',
      objectId: entry.id,
      after: { direction: entry.direction, category: entry.category, amountFen: entry.amountFen },
    });
    return entry;
  }
}
