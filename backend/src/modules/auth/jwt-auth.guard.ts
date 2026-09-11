import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { JwtPayload } from './auth.types';

/** 全局认证守卫：除 @Public() 外一律校验 Bearer access token */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: JwtPayload;
    }>();
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) {
      throw new AppException(ErrorCode.UNAUTHORIZED, '未认证：缺少访问令牌');
    }
    const payload = this.auth.verify(token);
    if (payload.type !== 'access') {
      throw new AppException(ErrorCode.AUTH_TOKEN_INVALID, '令牌类型错误');
    }
    req.user = payload;
    return true;
  }
}
