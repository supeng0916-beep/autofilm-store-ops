import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** 版本信息（2026-08-27 老板需求：客户报障先对版本）。
 * 优先读构建时烙入的 dist/version.json（postbuild 钩子 stamp-version.js 产出）——版本随产物走，
 * 热更/升级包只带 dist 也能对出版本，不依赖目标机 package.json（升级包刻意不含它）。
 * 回退链：dist/version.json → package.json version + dist/main.js 修改时间（开发机直跑场景）。
 * startedAt=本进程模块加载时刻（≈进程启动）。首次调用后缓存（进程生命周期内不变）。 */
export interface VersionInfo {
  version: string;
  buildTime: string | null;
  startedAt: string;
}

let cached: VersionInfo | null = null;
const startedAt = new Date().toISOString();

export function getVersionInfo(): VersionInfo {
  if (cached) return cached;
  let version = 'unknown';
  let buildTime: string | null = null;
  try {
    const stamped = JSON.parse(
      readFileSync(resolve(process.cwd(), 'dist', 'version.json'), 'utf8'),
    ) as { version?: string; builtAt?: string };
    if (stamped.version) version = stamped.version;
    if (stamped.builtAt) buildTime = stamped.builtAt;
  } catch {
    // dist/version.json 缺失（开发直跑 src/未构建）→ 回退 package.json + main.js mtime
    try {
      const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
        version?: string;
      };
      if (pkg.version) version = pkg.version;
    } catch {
      // 均不可读时保持 unknown（不影响健康检查主语义）
    }
    try {
      const entry = resolve(process.cwd(), 'dist', 'main.js');
      if (existsSync(entry)) buildTime = statSync(entry).mtime.toISOString();
    } catch {
      // dist 不存在则留空
    }
  }
  cached = { version, buildTime, startedAt };
  return cached;
}
