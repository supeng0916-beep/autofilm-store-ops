import { SetMetadata } from '@nestjs/common';

/** 标记免认证路由（login/refresh/health） */
export const IS_PUBLIC_KEY = 'auth.isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
