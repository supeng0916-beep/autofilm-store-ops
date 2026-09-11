import axios from 'axios';

import { http } from './http';

/** 版本信息（GET /health 公开端点附带；2026-08-27 客户报障先对版本） */
export interface HealthVersionInfo {
  status: string;
  app: string;
  env: string;
  version: string;
  buildTime: string | null;
  startedAt: string;
}

/** 备份状态（GET /system/backup-status，boss） */
export interface BackupStatus {
  enabled: boolean;
  dir: string;
  count: number;
  latest: { file: string; sizeBytes: number; mtime: string } | null;
}

/** 备份执行结果（POST /system/backup/run，boss） */
export interface BackupRunResult {
  ok: boolean;
  file: string | null;
  sizeBytes: number | null;
  durationMs: number;
  error?: string;
}

/** 系统运维 API（2026-08-26 重启按钮；2026-08-27 补备份/诊断/版本） */
export const systemApi = {
  /** 重启整套服务（boss 硬校验）：202 受理后服务约 30~60 秒内恢复 */
  restartServices: () =>
    http
      .post<{ accepted: boolean; script: string }>('/system/services/restart')
      .then((r) => r.data),
  /** 手动立即备份（boss）：复用包内 ops/backup.sh，成功后通知与审计留痕 */
  runBackup: () => http.post<BackupRunResult>('/system/backup/run').then((r) => r.data),
  /** 备份状态（boss）：目录/份数/最近一份 */
  backupStatus: () => http.get<BackupStatus>('/system/backup-status').then((r) => r.data),
  /** 诊断包数据（boss）：版本/AI 统计/备份/磁盘/脱敏日志尾部 */
  diagnostics: () => http.get<Record<string, unknown>>('/system/diagnostics').then((r) => r.data),
};

/** 健康检查（公开端点，无鉴权）：重启按钮受理后轮询 down→up 用。
 * 直接走 axios 原始实例（绕开业务拦截器的错误弹窗——重启过程中请求失败是预期态，
 * 3 秒一次的轮询若每失败都弹提示，一次重启会刷出约 50 条）。 */
export async function pingHealth(timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await axios.get('/api/v1/health', { timeout: timeoutMs });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** 版本与健康信息（公开端点）：运维卡展示「客户跑的哪个版本」（同样静默，失败返回 null） */
export async function fetchHealthInfo(timeoutMs = 5000): Promise<HealthVersionInfo | null> {
  try {
    const res = await axios.get<HealthVersionInfo>('/api/v1/health', { timeout: timeoutMs });
    return res.data;
  } catch {
    return null;
  }
}

/** 诊断包落盘：JSON → 浏览器下载（文件名带日期，发给技术支持即可离线排障） */
export function downloadDiagnostics(bundle: Record<string, unknown>): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `autofilm-store-ops-诊断包-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
