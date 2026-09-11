import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchAiDailyCosts, fetchAiStatus, setAiSwitch } from '../ai';
import { http } from '../http';

// 整模块 mock http 实例：只断言路径/载荷契约，不发真实请求
vi.mock('../http', () => ({
  http: { get: vi.fn(), put: vi.fn() },
}));

describe('api/ai 请求契约（P2-09）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('setAiSwitch 统一注入 confirmed:true 并 PUT /ai/switches（全局）', async () => {
    const snap = { global: false, skills: [] };
    vi.mocked(http.put).mockResolvedValue({ data: snap });
    await expect(setAiSwitch({ scope: 'global', enabled: false })).resolves.toEqual(snap);
    expect(http.put).toHaveBeenCalledWith('/ai/switches', {
      scope: 'global',
      enabled: false,
      confirmed: true,
    });
  });

  it('setAiSwitch skill 级携带 taskType', async () => {
    vi.mocked(http.put).mockResolvedValue({
      data: { global: true, skills: [{ taskType: 'hello', enabled: false }] },
    });
    await setAiSwitch({ scope: 'skill', taskType: 'hello', enabled: false });
    expect(http.put).toHaveBeenCalledWith('/ai/switches', {
      scope: 'skill',
      taskType: 'hello',
      enabled: false,
      confirmed: true,
    });
  });

  it('fetchAiDailyCosts 默认近 7 天并以 params 传 days', async () => {
    vi.mocked(http.get).mockResolvedValue({ data: [] });
    await fetchAiDailyCosts();
    expect(http.get).toHaveBeenCalledWith('/ai/costs/daily', { params: { days: 7 } });
  });

  it('fetchAiStatus 请求 /ai/status 并返回 data', async () => {
    const status = { globalEnabled: true, healthy: true, notice: null };
    vi.mocked(http.get).mockResolvedValue({ data: status });
    await expect(fetchAiStatus()).resolves.toEqual(status);
    expect(http.get).toHaveBeenCalledWith('/ai/status');
  });
});
