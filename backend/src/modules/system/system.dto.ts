import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { ROLE_CODES } from '../auth/permissions';

export class CreateUserDto extends createZodDto(
  z.object({
    username: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9._-]+$/, '用户名限小写字母/数字/._-'),
    displayName: z.string().min(1).max(64),
    password: z.string().min(8).max(128),
    roleCodes: z.array(z.enum(ROLE_CODES)).min(1),
  }),
) {}

export class SetRolesDto extends createZodDto(
  z.object({ roleCodes: z.array(z.enum(ROLE_CODES)).min(1) }),
) {}

export class SetDisabledDto extends createZodDto(z.object({ disabled: z.boolean() })) {}
