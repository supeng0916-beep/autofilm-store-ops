import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentApi } from '../agent';
import { http } from '../http';

// 整模块 mock http 实例：只断言路径/载荷契约，不发真实请求（沿 api/__tests__/ai.spec 手法）
vi.mock('../http', () => ({
  http: { get: vi.fn() },
  TOKEN_KEY: 'token',
}));

describe('api/agent persona 请求契约（V1.5）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persona GET /agent/persona 并透传 persona+displayName', async () => {
    const data = { persona: 'boss', displayName: '老板助手' };
    vi.mocked(http.get).mockResolvedValue({ data });
    await expect(agentApi.persona()).resolves.toEqual(data);
    expect(http.get).toHaveBeenCalledWith('/agent/persona');
  });
});
