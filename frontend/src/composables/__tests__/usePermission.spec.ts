import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { usePermission } from '../usePermission';

// mock store：composable 只做委托，命中与否由 auth.has 决定
const has = vi.fn<(perm: string) => boolean>();
vi.mock('../../stores/auth', () => ({
  useAuthStore: () => ({ has }),
}));

describe('usePermission（P1-02 前端）', () => {
  beforeEach(() => {
    has.mockReset();
    // composable 在无活跃 Pinia 时降级全 false（2026-08-26 审查 #7 口径），
    // 验证委托语义前先装一个空 Pinia
    setActivePinia(createPinia());
  });

  it('can() 命中：委托 store.has 并返回 true', () => {
    has.mockReturnValue(true);
    const { can } = usePermission();
    expect(can('m03:edit')).toBe(true);
    expect(has).toHaveBeenCalledWith('m03:edit');
  });

  it('can() 未命中：返回 false', () => {
    has.mockReturnValue(false);
    const { can } = usePermission();
    expect(can('system:manage')).toBe(false);
    expect(has).toHaveBeenCalledWith('system:manage');
  });
});
