import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { JwtPayload } from '../auth/auth.types';
import { NotificationService } from '../notification/notification.service';
import { SystemRepository } from './system.repository';

/** 备份执行结果（手动端点返回 / 诊断引用） */
export interface BackupRunResult {
  ok: boolean;
  file: string | null;
  sizeBytes: number | null;
  durationMs: number;
  error?: string;
}

/** 每日自动备份（2026-08-27 老板需求）：复用随包 ops/backup.sh（pg_dump 全量自定义格式 +
 * 自动保留最近 14 份 + 过期清理），成败均通知 boss 并写审计。
 * - 定时：每日 03:00（门店本地时区）；WG_AUTO_BACKUP=off 可整体关闭（状态端点可见）
 * - 环境：ops/backup.sh 仅部署包内有——dev/CI 下 cron 静默跳过，手动触发返回明确错误（同重启先例）
 * - 数据红线不受影响：备份文件落在门店机本地目录（包根 backups/），不出机器 */
@Injectable()
export class SystemBackupService {
  private readonly logger = new Logger(SystemBackupService.name);

  constructor(
    private readonly repo: SystemRepository,
    private readonly audit: AuditService,
    private readonly notify: NotificationService,
  ) {}

  /** 每日 03:00 自动备份（成败通知 boss） */
  @Cron('0 3 * * *')
  async dailyBackup(): Promise<void> {
    if (this.disabled()) {
      this.logger.log('WG_AUTO_BACKUP=off，跳过每日备份');
      return;
    }
    const script = this.resolveScript();
    if (!script) {
      this.logger.log('未找到 ops/backup.sh（非部署包环境），跳过每日备份');
      return;
    }
    await this.run('cron', script, null);
  }

  /** 手动立即备份（boss 硬校验；返回执行结果供前端展示） */
  async runManual(actor: JwtPayload): Promise<BackupRunResult> {
    const user = await this.repo.findById(actor.sub);
    const roles = user?.userRoles.map((ur) => ur.role.code) ?? [];
    if (!roles.includes('boss')) {
      throw new AppException(ErrorCode.PERM_DENIED, '仅老板可执行备份');
    }
    const script = this.resolveScript();
    if (!script) {
      throw new AppException(
        ErrorCode.INTERNAL,
        '备份脚本不可用：请确认部署包内 ops/backup.sh 存在',
      );
    }
    return this.run('manual', script, actor);
  }

  /** 备份状态（诊断与运维卡）：目录、份数、最近一份概要；boss 硬校验（端点入口） */
  async statusFor(actor: JwtPayload): Promise<ReturnType<SystemBackupService['status']>> {
    const user = await this.repo.findById(actor.sub);
    const roles = user?.userRoles.map((ur) => ur.role.code) ?? [];
    if (!roles.includes('boss')) {
      throw new AppException(ErrorCode.PERM_DENIED, '仅老板可查看备份状态');
    }
    return this.status();
  }

  status(): {
    enabled: boolean;
    dir: string;
    count: number;
    latest: { file: string; sizeBytes: number; mtime: string } | null;
  } {
    const dir = process.env.WG_BACKUP_DIR?.trim() || resolve(process.cwd(), '..', '..', 'backups');
    let files: string[] = [];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.dump'))
        .sort((a, b) => b.localeCompare(a));
    } catch {
      // 目录不存在（从未备份过）→ count 0
    }
    let latest: { file: string; sizeBytes: number; mtime: string } | null = null;
    if (files.length > 0) {
      const full = resolve(dir, files[0]);
      const st = statSync(full);
      latest = { file: files[0], sizeBytes: st.size, mtime: st.mtime.toISOString() };
    }
    return { enabled: !this.disabled(), dir, count: files.length, latest };
  }

  private disabled(): boolean {
    const v = process.env.WG_AUTO_BACKUP?.trim().toLowerCase();
    return v === 'off' || v === '0' || v === 'false';
  }

  /** 脚本定位：env 显式优先（可测性），缺省兜底包内 ../../ops/backup.sh */
  private resolveScript(): string | null {
    const fromEnv = process.env.WG_BACKUP_SCRIPT?.trim();
    if (fromEnv && existsSync(resolve(process.cwd(), fromEnv))) {
      return resolve(process.cwd(), fromEnv);
    }
    const fallback = resolve(process.cwd(), '..', '..', 'ops', 'backup.sh');
    return existsSync(fallback) ? fallback : null;
  }

  private async run(
    trigger: 'cron' | 'manual',
    script: string,
    actor: JwtPayload | null,
  ): Promise<BackupRunResult> {
    const db = this.dbName();
    const startedAt = Date.now();
    const res = await this.exec(script, db);
    const durationMs = Date.now() - startedAt;
    const sizeText = res.sizeBytes ? `${(res.sizeBytes / 1024 / 1024).toFixed(1)}MB` : '';
    if (res.ok) {
      await this.notify.notifyRoleHolders(['boss'], {
        kind: 'system.backup',
        title: trigger === 'cron' ? '每日数据库备份完成' : '手动备份完成',
        body: `文件 ${res.file ?? ''}${sizeText ? `（${sizeText}）` : ''}，耗时 ${(durationMs / 1000).toFixed(0)} 秒，保留最近 14 份。`,
      });
    } else {
      this.logger.warn(`备份失败（${trigger}）：${res.error}`);
      await this.notify.notifyRoleHolders(['boss'], {
        kind: 'system.backup',
        title: '数据库备份失败',
        body: `错误摘要：${res.error ?? '未知'}。请点「重启服务」重试一次，仍失败请联系技术支持（手动备份：bash ops/backup.sh）。`,
      });
    }
    await this.audit.record({
      ...(actor
        ? { actorId: actor.sub, actorName: actor.username }
        : { actorId: 'system', actorName: 'system' }),
      action: res.ok ? 'system.backup.success' : 'system.backup.failed',
      objectType: 'system',
      objectId: 'backup',
      after: { trigger, ok: res.ok, file: res.file, sizeBytes: res.sizeBytes, durationMs },
    });
    return { ...res, durationMs };
  }

  /** 库名取自 WG_DATABASE_URL pathname（缺省 autofilm_prod，对齐启动.command 默认） */
  private dbName(): string {
    const url = process.env.WG_DATABASE_URL?.trim();
    if (url) {
      try {
        const name = new URL(url).pathname.replace(/^\//, '');
        if (name) return name;
      } catch {
        // 非法 URL 落回默认
      }
    }
    return 'autofilm_prod';
  }

  /** 执行备份脚本：bash <script> <db>；10 分钟超时强杀；stdout 末行即脚本输出的文件路径 */
  private exec(
    script: string,
    db: string,
  ): Promise<{ ok: boolean; file: string | null; sizeBytes: number | null; error?: string }> {
    return new Promise((resolveFn) => {
      const child = spawn('bash', [script, db], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60 * 1000);
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      child.on('error', (e) => {
        clearTimeout(timer);
        resolveFn({ ok: false, file: null, sizeBytes: null, error: e.message.slice(0, 200) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          resolveFn({
            ok: false,
            file: null,
            sizeBytes: null,
            error: (err || out || `退出码 ${code}`).slice(0, 200),
          });
          return;
        }
        // 脚本输出「✅ 备份完成：<路径>（…）」——提取冒号后路径
        const m = out.match(/备份完成：(\S+?\.dump)/);
        const file = m?.[1] ?? null;
        let sizeBytes: number | null = null;
        if (file && existsSync(file)) sizeBytes = statSync(file).size;
        resolveFn({ ok: true, file, sizeBytes });
      });
    });
  }
}
