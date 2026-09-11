import { http } from './http';

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}

export interface MeResult {
  user: SessionUser;
  roles: string[];
  /** 权限点并集（后端 permissionsOf 计算；前端仅用于渲染过滤，安全边界在后端） */
  permissions: string[];
}

export function login(username: string, password: string): Promise<LoginResult> {
  return http.post<LoginResult>('/auth/login', { username, password }).then((r) => r.data);
}

export function fetchMe(): Promise<MeResult> {
  return http.get<MeResult>('/auth/me').then((r) => r.data);
}

/** 自行改密（任务书 #11）：验旧密+新密 6~64 位；成功返回 { ok: true } */
export function changePassword(oldPassword: string, newPassword: string): Promise<{ ok: true }> {
  return http
    .post<{ ok: true }>('/auth/change-password', { oldPassword, newPassword })
    .then((r) => r.data);
}
