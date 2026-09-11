import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { JwtPayload } from './auth.types';

/** 从请求上取当前会话用户（由 JwtAuthGuard 写入） */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const req = ctx.switchToHttp().getRequest<{ user: JwtPayload }>();
    return req.user;
  },
);
