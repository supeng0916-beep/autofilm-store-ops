import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { AuditService } from '../../common/audit';
import { permissionsOf, type Permission } from './permissions';
import { REQUIRED_PERMISSIONS_KEY } from './require-permission.decorator';
import { UsersRepository } from './users.repository';
import type { JwtPayload } from './auth.types';

/** 授权守卫：在 JwtAuthGuard 之后执行；越权拒绝并写审计（P1-02 验收） */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<{ user?: JwtPayload; ip?: string }>();
    const session = req.user;
    // fail-closed：有权限要求却无会话时一律 401。
    // 堵住 @Public() 与 @RequirePermission() 同标时权限检查被静默绕过的未来绕过面。
    if (!session) {
      throw new AppException(ErrorCode.UNAUTHORIZED, '未认证');
    }

    const user = await this.users.findById(session.sub);
    // 账号已停用：即使持有未过期令牌也拒绝（user 为 null = 账号已删，走下方空权限拒绝逻辑）
    if (user?.disabled) {
      throw new AppException(ErrorCode.AUTH_ACCOUNT_DISABLED, '账号已停用');
    }
    const owned = permissionsOf(user?.userRoles.map((ur) => ur.role.code) ?? []);
    if (required.some((p) => owned.has(p))) return true;

    // 退出标准：越权被拒并留痕——先写审计再抛 403 PERM_DENIED
    await this.audit.record({
      actorId: session.sub,
      actorName: session.username,
      action: 'auth.permission.denied',
      objectType: 'permission',
      objectId: required.join(','),
      ip: req.ip,
      after: { required },
    });
    throw new AppException(ErrorCode.PERM_DENIED, '无权执行该操作');
  }
}
