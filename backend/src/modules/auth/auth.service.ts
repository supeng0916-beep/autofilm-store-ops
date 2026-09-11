import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';

import { ErrorCode } from '../../common/errors/error-code';
import { AppException } from '../../common/errors/app.exception';
import { AuditService } from '../../common/audit';
import { UsersRepository } from './users.repository';
import type { JwtPayload, SessionUser } from './auth.types';

/** 登录锁定策略：5 次失败锁 15 分钟（常量集中，便于审计口径一致） */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

/** 哑哈希：用户不存在时也执行一次比对，均衡响应耗时，不泄露账号存在性。
 * 由 argon2.hash('x') 真实生成（非示意串），保证 verify 行为正常。 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$kwnuDyjFSJdqtkeTYIWqUQ$FAfHJHiXbJhJ1Q8PVBwDnknnLrwQUvVFdD9FCGjcV6Q';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain);
  }

  async login(
    username: string,
    password: string,
    ip?: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    user: SessionUser;
  }> {
    const user = await this.users.findByUsername(username);
    const ok = await argon2.verify(user?.passwordHash ?? DUMMY_HASH, password).catch(() => false);

    if (!user || !ok) {
      if (user) {
        const attempts = user.failedAttempts + 1;
        const lock = attempts >= MAX_FAILED_ATTEMPTS;
        await this.users.updateAuthState(user.id, {
          failedAttempts: lock ? 0 : attempts,
          lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : user.lockedUntil,
        });
        if (lock) {
          await this.audit.record({
            actorId: user.id,
            actorName: user.username,
            action: 'auth.account.locked',
            objectType: 'user',
            objectId: user.id,
            ip,
            after: { lockedMinutes: LOCK_MINUTES },
          });
          throw new AppException(
            ErrorCode.AUTH_ACCOUNT_LOCKED,
            `密码错误次数过多，账号已锁定 ${LOCK_MINUTES} 分钟，请稍后再试`,
          );
        } else {
          await this.audit.record({
            actorId: user.id,
            actorName: user.username,
            action: 'auth.login.failure',
            objectType: 'user',
            objectId: user.id,
            ip,
            after: { failedAttempts: attempts },
          });
          throw new AppException(ErrorCode.AUTH_INVALID_CREDENTIALS, '用户名或密码错误', {
            remainingAttempts: MAX_FAILED_ATTEMPTS - attempts,
          });
        }
      } else {
        await this.audit.record({
          action: 'auth.login.failure',
          objectType: 'user',
          ip,
          after: { username },
        });
      }
      throw new AppException(ErrorCode.AUTH_INVALID_CREDENTIALS, '用户名或密码错误');
    }

    if (user.disabled) {
      throw new AppException(ErrorCode.AUTH_ACCOUNT_DISABLED, '账号已停用，请联系管理员');
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new AppException(
        ErrorCode.AUTH_ACCOUNT_LOCKED,
        `账号已锁定（连续 ${MAX_FAILED_ATTEMPTS} 次失败），约 ${remainingLockMinutes(user.lockedUntil)} 分钟后自动解锁`,
      );
    }

    if (user.failedAttempts > 0) {
      await this.users.updateAuthState(user.id, { failedAttempts: 0, lockedUntil: null });
    }
    await this.audit.record({
      actorId: user.id,
      actorName: user.username,
      action: 'auth.login.success',
      objectType: 'user',
      objectId: user.id,
      ip,
    });

    const session: SessionUser = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
    };
    return {
      accessToken: this.sign(user.id, user.username, 'access'),
      refreshToken: this.sign(user.id, user.username, 'refresh'),
      user: session,
    };
  }

  async refresh(
    refreshToken: string,
    ip?: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const payload = this.verify(refreshToken);
    if (payload.type !== 'refresh') {
      throw new AppException(ErrorCode.AUTH_TOKEN_INVALID, '令牌类型错误');
    }
    const user = await this.users.findById(payload.sub);
    if (!user || user.disabled) {
      throw new AppException(ErrorCode.AUTH_TOKEN_INVALID, '令牌已失效');
    }
    // 锁定 = 禁止再认证（含续期）：锁定窗口内 refresh 同样拒绝
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new AppException(ErrorCode.AUTH_ACCOUNT_LOCKED, '账号已锁定，请稍后再试');
    }
    await this.audit.record({
      actorId: user.id,
      actorName: user.username,
      action: 'auth.token.refresh',
      objectType: 'user',
      objectId: user.id,
      ip,
    });
    return {
      accessToken: this.sign(user.id, user.username, 'access'),
      refreshToken: this.sign(user.id, user.username, 'refresh'),
    };
  }

  /** 自行改密（任务书 #11）：验旧密→更新哈希→审计。
   * 与登录失败的锁定策略刻意解耦：改密失败不累计 failedAttempts（锁定口径仅针对登录），
   * 故错误响应不带 remainingAttempts。 */
  async changePassword(userId: string, oldPassword: string, newPassword: string, ip?: string) {
    const user = await this.users.findById(userId);
    if (!user) {
      // token 有效但账号已删除：按未认证处理（与 /auth/me 口径一致）
      throw new AppException(ErrorCode.AUTH_TOKEN_INVALID, '令牌已失效');
    }
    if (user.disabled) {
      throw new AppException(ErrorCode.AUTH_ACCOUNT_DISABLED, '账号已停用，请联系管理员');
    }
    const ok = await argon2.verify(user.passwordHash, oldPassword).catch(() => false);
    if (!ok) {
      throw new AppException(ErrorCode.AUTH_INVALID_CREDENTIALS, '原密码错误');
    }
    await this.users.updatePasswordHash(user.id, await argon2.hash(newPassword));
    await this.audit.record({
      actorId: user.id,
      actorName: user.username,
      action: 'auth.password_changed',
      objectType: 'user',
      objectId: user.id,
      ip,
      after: {}, // 新旧口令均不入审计（S04 脱敏）
    });
  }

  verify(token: string): JwtPayload {
    try {
      return this.jwt.verify<JwtPayload>(token);
    } catch (err) {
      // 按错误名判定过期（jsonwebtoken 抛 TokenExpiredError），不依赖错误文案
      if (err instanceof Error && err.name === 'TokenExpiredError') {
        throw new AppException(ErrorCode.AUTH_TOKEN_EXPIRED, '登录已过期，请重新登录');
      }
      throw new AppException(ErrorCode.AUTH_TOKEN_INVALID, '令牌无效');
    }
  }

  private sign(sub: string, username: string, type: 'access' | 'refresh'): string {
    return this.jwt.sign({ sub, username, type }, { expiresIn: type === 'access' ? '15m' : '7d' });
  }
}

/** 锁定剩余分钟（向上取整，至少 1） */
function remainingLockMinutes(lockedUntil: Date | null): number {
  if (!lockedUntil) return LOCK_MINUTES;
  return Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 60_000));
}
