import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class LoginDto extends createZodDto(
  z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(128) }),
) {}

export class RefreshDto extends createZodDto(z.object({ refreshToken: z.string().min(20) })) {}

/** 自行改密（任务书 #11）：旧密验证 + 新密 6~64 位；过短/超长由管道判 VALIDATION_FAILED → 400 */
export class ChangePasswordDto extends createZodDto(
  z.object({
    oldPassword: z.string().min(1).max(128),
    newPassword: z.string().min(6, '新密码至少 6 位').max(64, '新密码最多 64 位'),
  }),
) {}
