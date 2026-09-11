import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditService } from '../../common/audit';
import { PrismaService } from '../../prisma/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { JwtPayload } from '../auth/auth.types';
import { AiTaskRegistry } from './ai-dispatch.registry';

/** 技能提示词版本管理与一键回滚（V1.5 批次5，轻量 git 方案）：
 * - 版本真源=git：SKILL.md frontmatter `version: N` 与注册表 skillVersion 由提交纪律同步；
 *   每次提交落 ai_tasks.skill_version（运行留痕）。
 * - 快照约定：`<skillsDir>/<skillName>@v<N>/SKILL.md`（随 git 提交，部署即在）。
 * - 回滚=快照内容覆盖技能目录 SKILL.md（网关按请求读文件，热加载即时生效）+
 *   注册表 skillVersion 同步更新（此后新任务落新版本号）+ 审计。
 * - 门禁：boss ∪ sys_admin 角色硬校验（沿 ai-cost 提额先例——system:manage 仅 sys_admin 持有）。 */
@Injectable()
export class SkillVersionService {
  constructor(
    private readonly config: ConfigService,
    private readonly registry: AiTaskRegistry,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  /** 门禁：boss ∪ sys_admin 角色硬校验（沿 ai-cost 提额先例） */
  private async assertBossOrAdmin(actor: JwtPayload): Promise<void> {
    const roles = await this.prisma.userRole.findMany({
      where: { userId: actor.sub },
      select: { role: { select: { code: true } } },
    });
    const codes = roles.map((r) => r.role.code);
    if (!codes.includes('boss') && !codes.includes('sys_admin')) {
      throw new AppException(ErrorCode.PERM_DENIED, '仅老板或系统管理员可管理技能版本');
    }
  }

  private skillsDir(): string {
    return (
      this.config.get<string>('WG_OPENCLAW_SKILLS_DIR') ??
      join(process.cwd(), '..', 'openclaw', 'skills')
    );
  }

  /** frontmatter 的 version 字段（解析失败返回 null） */
  private readVersion(file: string): number | null {
    const m = readFileSync(file, 'utf8').match(/^---\n[\s\S]*?^version:\s*(\d+)\s*$/m);
    return m ? Number(m[1]) : null;
  }

  private snapshotsOf(skillName: string): number[] {
    const dir = this.skillsDir();
    if (!existsSync(dir)) return [];
    const versions: number[] = [];
    for (const entry of readdirSync(dir)) {
      const m = entry.match(
        new RegExp(`^${skillName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}@v(\\d+)$`),
      );
      if (m) versions.push(Number(m[1]));
    }
    return versions.sort((a, b) => a - b);
  }

  /** 全量技能版本视图：注册表口径 + 快照目录可回滚版本 */
  async versions(actor: JwtPayload): Promise<
    Array<{
      taskType: string;
      skillName: string;
      current: number | null;
      versions: number[];
    }>
  > {
    await this.assertBossOrAdmin(actor);
    return this.registry.list().map((def) => ({
      taskType: def.taskType,
      skillName: def.skillName,
      current: def.skillVersion ?? null,
      versions: this.snapshotsOf(def.skillName),
    }));
  }

  /** 一键回滚：快照覆盖当前技能文件 + 注册表版本更新 + 审计。version 必须是存在的快照 */
  async rollback(
    actor: JwtPayload,
    input: { skillName: string; version: number },
  ): Promise<{ ok: true; skillName: string; version: number }> {
    // 门禁：boss ∪ sys_admin（system:manage 按 permissions.ts 口径不含 boss，沿提额先例按角色判）
    await this.assertBossOrAdmin(actor);
    const target = join(this.skillsDir(), `${input.skillName}@v${input.version}`, 'SKILL.md');
    if (!existsSync(target)) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        `快照 ${input.skillName}@v${input.version} 不存在`,
      );
    }
    const version = this.readVersion(target);
    if (version === null) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, '快照 SKILL.md 缺 version frontmatter');
    }
    const active = join(this.skillsDir(), input.skillName, 'SKILL.md');
    if (!existsSync(active)) {
      throw new AppException(ErrorCode.NOT_FOUND, `技能目录 ${input.skillName} 不存在`);
    }
    const before = this.readVersion(active);
    copyFileSync(target, active);
    // 注册表同步（该 skillName 的全部 taskType 更新版本号——新任务落新版本）
    for (const def of this.registry.list()) {
      if (def.skillName === input.skillName) {
        this.registry.register({ ...def, skillVersion: version });
      }
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'ai.skill.rolled_back',
      objectType: 'ai_skill',
      objectId: input.skillName,
      before: { version: before },
      after: { version },
    });
    return { ok: true, skillName: input.skillName, version };
  }
}
