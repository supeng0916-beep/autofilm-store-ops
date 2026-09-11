import { SetMetadata } from '@nestjs/common';

import type { Permission } from './permissions';

export const REQUIRED_PERMISSIONS_KEY = 'auth.requiredPermissions';

/** 声明端点所需权限点（任一满足即通过；无装饰器 = 仅需认证） */
export const RequirePermission = (...perms: Permission[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, perms);
