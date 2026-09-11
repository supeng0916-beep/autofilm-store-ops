import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from '../auth';

vi.mock('../../api/auth', () => ({
  login: vi.fn(async () => ({
    accessToken: 'at',
    refreshToken: 'rt',
    user: { id: 'u1', username: 'alice', displayName: '爱丽丝' },
  })),
  fetchMe: vi.fn(async () => ({
    user: { id: 'u1', username: 'alice', displayName: '爱丽丝' },
    roles: ['boss'],
    permissions: ['m01:view', 'm02:approve', 'approval:decide'],
  })),
}));

describe('useAuthStore（P1-01 前端）', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('login 写入 token 与用户；logout 清空', async () => {
    const store = useAuthStore();
    await store.login('alice', 'pw');
    expect(store.isLoggedIn).toBe(true);
    expect(store.roles).toEqual(['boss']);
    expect(localStorage.getItem('wg.accessToken')).toBe('at');

    store.logout();
    expect(store.isLoggedIn).toBe(false);
    expect(localStorage.getItem('wg.accessToken')).toBeNull();
  });

  it('fetchMe 写入权限点，has() 命中/未命中（P1-02）', async () => {
    const store = useAuthStore();
    await store.login('alice', 'pw');
    expect(store.permissions).toEqual(['m01:view', 'm02:approve', 'approval:decide']);
    expect(store.has('m02:approve')).toBe(true);
    expect(store.has('system:manage')).toBe(false);

    store.logout();
    expect(store.permissions).toEqual([]);
  });
});
