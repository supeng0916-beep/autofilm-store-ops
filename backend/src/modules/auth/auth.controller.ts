import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { CurrentUser } from './current-user.decorator';
import { Public } from './public.decorator';
import { LoginDto, RefreshDto, ChangePasswordDto } from './auth.dto';
import { AuthService } from './auth.service';
import { UsersRepository } from './users.repository';
import { permissionsOf } from './permissions';
import type { JwtPayload } from './auth.types';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersRepository,
  ) {}

  @Public()
  @Post('login')
  login(@Body() body: LoginDto, @Req() req: Request) {
    return this.auth.login(body.username, body.password, req.ip);
  }

  @Public()
  @Post('refresh')
  refresh(@Body() body: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(body.refreshToken, req.ip);
  }

  /** 自行改密（任务书 #11）：仅需认证（无 @Public），验旧密后更新哈希 */
  @Post('change-password')
  async changePassword(
    @Body() body: ChangePasswordDto,
    @CurrentUser() session: JwtPayload,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.auth.changePassword(session.sub, body.oldPassword, body.newPassword, req.ip);
    return { ok: true };
  }

  @Get('me')
  async me(@CurrentUser() session: JwtPayload) {
    const user = await this.users.findById(session.sub);
    if (!user) {
      // token 有效但账号已删除：按未认证处理
      throw new AppException(ErrorCode.AUTH_TOKEN_INVALID, '令牌已失效');
    }
    if (user.disabled) {
      // 停用账号的未过期令牌立即失效，不再等 access token 自然过期
      throw new AppException(ErrorCode.AUTH_ACCOUNT_DISABLED, '账号已停用，请联系管理员');
    }
    return {
      user: { id: user.id, username: user.username, displayName: user.displayName },
      roles: user.userRoles.map((ur) => ur.role.code),
      permissions: [...permissionsOf(user.userRoles.map((ur) => ur.role.code))],
    };
  }
}
