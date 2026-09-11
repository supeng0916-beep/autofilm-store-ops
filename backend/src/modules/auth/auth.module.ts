import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionGuard } from './permission.guard';
import { UsersRepository } from './users.repository';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('WG_JWT_SECRET'),
      }),
    }),
    // 全站限流：与认证/授权 guard 同模块注册，保证 APP_GUARD 顺序确定（限流→认证→授权）
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: (config.get<number>('WG_RATE_LIMIT_TTL') ?? 60) * 1000,
            limit: config.get<number>('WG_RATE_LIMIT_MAX') ?? 600,
          },
        ],
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    UsersRepository,
    // APP_GUARD 按 providers 数组内注册顺序执行：先限流，再认证（JwtAuthGuard），后授权（PermissionGuard）
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  exports: [AuthService, UsersRepository],
})
export class AuthModule {}
