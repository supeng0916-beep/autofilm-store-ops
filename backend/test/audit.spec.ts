import { INestApplication } from '@nestjs/common';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { AuditService } from '../src/common/audit/audit.service';
import { AuditRepository } from '../src/common/audit/audit.repository';
import { buildApp } from './setup';

describe('审计日志基础（P1-03）', () => {
  let app: INestApplication;
  let service: AuditService;
  let repo: AuditRepository;

  beforeAll(async () => {
    // AuditModule 已挂 AppModule（Step 3）；buildApp 提供 ConfigModule 等完整 DI 上下文
    app = await buildApp();
    service = app.get(AuditService);
    repo = app.get(AuditRepository);
  });

  afterAll(async () => {
    await app.close();
  });

  it('record 写入完整字段并可按对象回查', async () => {
    const suffix = Date.now().toString(36);
    const log = await service.record({
      actorName: 'tester',
      action: 'audit.spec.probe',
      objectType: 'spec_object',
      objectId: suffix,
      before: { a: 1 },
      after: { a: 2 },
      ip: '127.0.0.1',
    });
    expect(log.id).toBeTruthy();
    const rows = await repo.findMany({ objectType: 'spec_object', objectId: suffix });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('audit.spec.probe');
  });

  it('repository 只增不改：不暴露 update/delete 方法（验收标准）', () => {
    // strict TS 下类实例不能直接断言为 Record，经 unknown 中转做反射检查
    const repoAny = repo as unknown as Record<string, unknown>;
    expect(repoAny.update).toBeUndefined();
    expect(repoAny.delete).toBeUndefined();
    expect(repoAny.upsert).toBeUndefined();
  });
});
