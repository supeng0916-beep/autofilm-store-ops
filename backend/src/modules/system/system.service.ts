import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { AuthService } from '../auth/auth.service';
import type { JwtPayload } from '../auth/auth.types';
import { CreateUserDto, SetDisabledDto, SetRolesDto } from './system.dto';
import { SystemRepository } from './system.repository';

/** 对外视图：永不回传 passwordHash（S04） */
function toPublic(user: {
  id: string;
  username: string;
  displayName: string;
  disabled: boolean;
  userRoles: { role: { code: string } }[];
}) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    disabled: user.disabled,
    roles: user.userRoles.map((ur) => ur.role.code),
  };
}

@Injectable()
export class SystemService {
  constructor(
    private readonly repo: SystemRepository,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  async listUsers() {
    const users = await this.repo.listUsers();
    return users.map(toPublic);
  }

  async createUser(dto: CreateUserDto, actor: JwtPayload) {
    const exists = await this.repo.findByUsername(dto.username);
    if (exists) {
      throw new AppException(ErrorCode.CONFLICT, '用户名已存在');
    }
    // 建号+赋角色在同一事务内（repository 层），失败整体回滚，避免无角色孤儿账号
    const user = await this.repo.createUserWithRoles(
      {
        username: dto.username,
        displayName: dto.displayName,
        passwordHash: await this.auth.hashPassword(dto.password),
      },
      dto.roleCodes,
    );
    const created = await this.repo.findById(user.id);
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'user.created',
      objectType: 'user',
      objectId: user.id,
      after: { username: dto.username, displayName: dto.displayName, roleCodes: dto.roleCodes },
    });
    return toPublic(created!);
  }

  async setRoles(id: string, dto: SetRolesDto, actor: JwtPayload) {
    const user = await this.repo.findById(id);
    if (!user) {
      throw new AppException(ErrorCode.NOT_FOUND, '用户不存在');
    }
    const before = user.userRoles.map((ur) => ur.role.code);
    await this.repo.replaceRoles(id, dto.roleCodes);
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'user.roles.changed',
      objectType: 'user',
      objectId: id,
      before: { roleCodes: before },
      after: { roleCodes: dto.roleCodes },
    });
    return { id, roleCodes: dto.roleCodes };
  }

  async setDisabled(id: string, dto: SetDisabledDto, actor: JwtPayload) {
    const user = await this.repo.findById(id);
    if (!user) {
      throw new AppException(ErrorCode.NOT_FOUND, '用户不存在');
    }
    await this.repo.setDisabled(id, dto.disabled);
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'user.disabled.changed',
      objectType: 'user',
      objectId: id,
      before: { disabled: user.disabled },
      after: { disabled: dto.disabled },
    });
    return { id, disabled: dto.disabled };
  }

  /** 重启整套服务（2026-08-26 老板需求：门店机睡眠挂断后的自助恢复入口）。
   * boss 角色硬校验（同 AI 临时提额先例：无权限点，服务层角色判定）；
   * 双保险：仅当 WG_RESTART_SCRIPT 指向存在脚本、或包内相对路径 ../../重启.command 存在时
   * 才 spawn detached 执行（开发/测试环境两者皆缺 → 明确拒绝，绝不误杀进程）。 */
  async restartServices(actor: JwtPayload): Promise<{ accepted: true; script: string }> {
    const user = await this.repo.findById(actor.sub);
    const roles = user?.userRoles.map((ur) => ur.role.code) ?? [];
    if (!roles.includes('boss')) {
      throw new AppException(ErrorCode.PERM_DENIED, '仅老板可重启服务');
    }
    const script = this.resolveRestartScript();
    if (!script) {
      throw new AppException(
        ErrorCode.INTERNAL,
        '重启脚本不可用：请配置 WG_RESTART_SCRIPT 或确认部署包内 重启.command 存在',
      );
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'system.services_restart',
      objectType: 'system',
      objectId: 'services',
      after: { script },
    });
    // detached + unref：不等子进程、不等本进程被脚本停掉，响应先落地；脚本自带 2 秒缓冲让响应送达
    const child = spawn('bash', [script], { detached: true, stdio: 'ignore' });
    child.unref();
    return { accepted: true, script };
  }

  /** 重启脚本定位：env 显式指定优先（相对路径按后端 cwd 解析），缺省兜底包内 ../../重启.command。 */
  private resolveRestartScript(): string | null {
    const fromEnv = process.env.WG_RESTART_SCRIPT?.trim();
    if (fromEnv) {
      const p = resolve(process.cwd(), fromEnv);
      if (existsSync(p)) return p;
    }
    const fallback = resolve(process.cwd(), '..', '..', '重启.command');
    return existsSync(fallback) ? fallback : null;
  }
}
