import { defineStore } from 'pinia';

import { fetchMe, login, type SessionUser } from '../api/auth';

const TOKEN_KEY = 'wg.accessToken';
const REFRESH_KEY = 'wg.refreshToken';

/** 认证状态：token 持久化到 localStorage（电脑端工作台、内网场景） */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem(TOKEN_KEY) ?? '',
    refreshToken: localStorage.getItem(REFRESH_KEY) ?? '',
    user: null as SessionUser | null,
    roles: [] as string[],
    permissions: [] as string[],
  }),
  getters: {
    isLoggedIn: (s) => s.token.length > 0,
    /** 权限点命中判断（仅控制渲染；安全边界在后端，矩阵 §5） */
    has:
      (s) =>
      (perm: string): boolean =>
        s.permissions.includes(perm),
  },
  actions: {
    async login(username: string, password: string): Promise<void> {
      const result = await login(username, password);
      this.token = result.accessToken;
      this.refreshToken = result.refreshToken;
      this.user = result.user;
      localStorage.setItem(TOKEN_KEY, result.accessToken);
      localStorage.setItem(REFRESH_KEY, result.refreshToken);
      await this.fetchMe();
    },
    async fetchMe(): Promise<void> {
      const me = await fetchMe();
      this.user = me.user;
      this.roles = me.roles;
      this.permissions = me.permissions;
    },
    logout(): void {
      this.token = '';
      this.refreshToken = '';
      this.user = null;
      this.roles = [];
      this.permissions = [];
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_KEY);
    },
  },
});
