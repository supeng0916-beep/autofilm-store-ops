import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { CreateUserDto, SetDisabledDto, SetRolesDto } from './system.dto';
import { SystemBackupService } from './system-backup.service';
import { SystemDiagnosticsService } from './system-diagnostics.service';
import { SystemService } from './system.service';

@Controller('system')
export class SystemController {
  constructor(
    private readonly system: SystemService,
    private readonly backup: SystemBackupService,
    private readonly diagnostics: SystemDiagnosticsService,
  ) {}

  @Get('users')
  @RequirePermission('system:manage')
  list() {
    return this.system.listUsers();
  }

  /** 重启整套服务（2026-08-26）：boss 角色硬校验在服务层（同 AI 临时提额先例，无权限点） */
  @Post('services/restart')
  @HttpCode(HttpStatus.ACCEPTED)
  restartServices(@CurrentUser() actor: JwtPayload) {
    return this.system.restartServices(actor);
  }

  /** 手动立即备份（2026-08-27 运维批次）：boss 硬校验在服务层 */
  @Post('backup/run')
  @HttpCode(HttpStatus.OK)
  runBackup(@CurrentUser() actor: JwtPayload) {
    return this.backup.runManual(actor);
  }

  /** 备份状态（2026-08-27）：目录/份数/最近一份；boss 硬校验在服务层 */
  @Get('backup-status')
  backupStatus(@CurrentUser() actor: JwtPayload) {
    return this.backup.statusFor(actor);
  }

  /** 诊断包导出（2026-08-27）：版本/AI 统计/备份/磁盘/脱敏日志尾部；boss 硬校验在服务层 */
  @Get('diagnostics')
  diagnosticsBundle(@CurrentUser() actor: JwtPayload) {
    return this.diagnostics.build(actor);
  }

  @Post('users')
  @RequirePermission('system:manage')
  create(@Body() body: CreateUserDto, @CurrentUser() actor: JwtPayload) {
    return this.system.createUser(body, actor);
  }

  @Post('users/:id/roles')
  @RequirePermission('system:manage')
  setRoles(@Param('id') id: string, @Body() body: SetRolesDto, @CurrentUser() actor: JwtPayload) {
    return this.system.setRoles(id, body, actor);
  }

  @Post('users/:id/disabled')
  @RequirePermission('system:manage')
  setDisabled(
    @Param('id') id: string,
    @Body() body: SetDisabledDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.system.setDisabled(id, body, actor);
  }
}
