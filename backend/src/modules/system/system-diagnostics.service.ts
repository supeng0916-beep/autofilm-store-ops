import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync, statfsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { getVersionInfo } from '../../common/version-info';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../prisma/prisma.service';
import { PHONE_RE, PLATE_RE, WECHAT_LABEL_RE, WXID_RE } from '../ai-dispatch/masker';
import type { JwtPayload } from '../auth/auth.types';
import { SystemBackupService } from './system-backup.service';

/** 诊断包（2026-08-27 老板需求：远程排障不再靠客户口述截图）。
 * GET /system/diagnostics（boss）一键产出 JSON 诊断包：版本/运行时长/数据库/AI 七日统计/
 * 备份状态/磁盘余量/日志尾部——**日志逐行脱敏**（手机号/车牌/微信号打码），客户数据红线不破。
 * 导出的 JSON 由前端落盘为文件，发给技术支持即可离线定位。 */
@Injectable()
export class SystemDiagnosticsService {
  private readonly logger = new Logger(SystemDiagnosticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly backup: SystemBackupService,
  ) {}

  async build(actor: JwtPayload): Promise<Record<string, unknown>> {
    // boss 硬校验（同重启/备份先例）——诊断含日志与运行细节，仅老板可导出
    const user = await this.prisma.user.findUnique({
      where: { id: actor.sub },
      select: { userRoles: { select: { role: { select: { code: true } } } } },
    });
    const roles = user?.userRoles.map((ur) => ur.role.code) ?? [];
    if (!roles.includes('boss')) {
      throw new AppException(ErrorCode.PERM_DENIED, '仅老板可导出诊断包');
    }

    const [dbOk, dbSizeBytes, ai7d, aiCost7d] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      this.prisma.$queryRaw<
        Array<{ size: bigint }>
      >`SELECT pg_database_size(current_database()) AS size`
        .then((rows) => Number(rows[0]?.size ?? 0))
        .catch(() => null),
      this.prisma.aiTask.groupBy({
        by: ['status'],
        _count: { _all: true },
        where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) } },
      }),
      this.prisma.aiTask.aggregate({
        _sum: { costEstimateFen: true },
        where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) } },
      }),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      version: getVersionInfo(),
      env: process.env.NODE_ENV ?? 'dev',
      uptimeSec: Math.round(process.uptime()),
      db: { ok: dbOk, sizeBytes: dbSizeBytes },
      ai: {
        last7d: ai7d.map((r) => ({ status: r.status, count: r._count._all })),
        costFen7d: aiCost7d._sum.costEstimateFen ?? 0,
      },
      backups: this.backup.status(),
      disk: this.diskFree(),
      logs: {
        run: this.tailMasked(resolve(process.cwd(), 'logs', 'run.log'), 400),
        gateway: this.tailMasked(resolve(process.cwd(), 'logs', 'openclaw-gateway.log'), 200),
      },
    };
  }

  /** 磁盘余量（进程所在卷）：statfs 不可用时留空不影响其余诊断项 */
  private diskFree(): { freeBytes: number | null; totalBytes: number | null } {
    try {
      const st = statfsSync(process.cwd());
      return {
        freeBytes: Number(st.bsize) * Number(st.bavail),
        totalBytes: Number(st.bsize) * Number(st.blocks),
      };
    } catch (err) {
      this.logger.warn(`磁盘信息读取失败：${err instanceof Error ? err.message : String(err)}`);
      return { freeBytes: null, totalBytes: null };
    }
  }

  /** 日志尾部（行数截取 + 敏感信息打码：手机号/车牌/微信号——数据红线，诊断包也不带明文） */
  private tailMasked(path: string, lines: number): string[] {
    try {
      if (!existsSync(path) || !statSync(path).isFile()) return [];
      const content = readFileSync(path, 'utf8');
      const tail = content.split('\n').slice(-lines);
      return tail.map((l) =>
        l
          .replace(PHONE_RE, '[手机号已脱敏]')
          .replace(PLATE_RE, '[车牌已脱敏]')
          .replace(WXID_RE, '[微信号已脱敏]')
          .replace(WECHAT_LABEL_RE, '[微信号已脱敏]'),
      );
    } catch {
      return [];
    }
  }
}
