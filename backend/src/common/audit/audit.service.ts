import { Injectable } from '@nestjs/common';
import type { AuditLog } from '@prisma/client';

import { AuditRepository } from './audit.repository';
import type { AuditInput } from './audit.types';

/** 审计服务：统一写入入口；调用方保证 before/after 已脱敏（S04） */
@Injectable()
export class AuditService {
  constructor(private readonly repo: AuditRepository) {}

  record(input: AuditInput): Promise<AuditLog> {
    return this.repo.create(input);
  }
}
