import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchAiStatus, type AiStatus } from '../../api/ai';
import { useAiStore } from '../ai';

// mock api 模块：轮询不发真实请求，状态逐用例指定
vi.mock('../../api/ai', () => ({
  fetchAiStatus: vi.fn(),
}));

function makeStatus(overrides: Partial<AiStatus> = {}): AiStatus {
  return {
    globalEnabled: true,
    healthy: true,
    lastHealthyAt: '2026-08-13T00:00:00.000Z',
    lastError: null,
    skills: [{ taskType: 'hello', enabled: true }],
    notice: null,
    ...overrides,
  };
}

describe('useAiStore（P2-09 AI 通道状态轮询）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('globalEnabled=false → unavailable，notice 文案固定', async () => {
    vi.mocked(fetchAiStatus).mockResolvedValue(makeStatus({ globalEnabled: false }));
    const store = useAiStore();
    await store.refresh();
    expect(store.unavailable).toBe(true);
    expect(store.notice).toBe('AI 暂不可用，请人工处理');
  });

  it('healthy=false 同样触发降级提示', async () => {
    vi.mocked(fetchAiStatus).mockResolvedValue(makeStatus({ healthy: false }));
    const store = useAiStore();
    await store.refresh();
    expect(store.unavailable).toBe(true);
    expect(store.notice).toBe('AI 暂不可用，请人工处理');
  });

  it('正常态（全局开 && 健康）notice 为 null', async () => {
    vi.mocked(fetchAiStatus).mockResolvedValue(makeStatus());
    const store = useAiStore();
    await store.refresh();
    expect(store.unavailable).toBe(false);
    expect(store.notice).toBeNull();
  });

  it('refresh 失败静默：保留上次 status 并标记 loadFailed', async () => {
    vi.mocked(fetchAiStatus).mockResolvedValueOnce(makeStatus());
    const store = useAiStore();
    await store.refresh();
    expect(store.status?.globalEnabled).toBe(true);
    expect(store.loadFailed).toBe(false);

    vi.mocked(fetchAiStatus).mockRejectedValueOnce(new Error('network down'));
    await store.refresh();
    expect(store.status?.globalEnabled).toBe(true); // 保留上次状态
    expect(store.loadFailed).toBe(true);
  });

  it('startPolling 立即刷新并按 60s 间隔轮询，stopPolling 后停止', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchAiStatus).mockResolvedValue(makeStatus());
    const store = useAiStore();

    store.startPolling();
    // advanceTimersByTimeAsync 兼顾定时器与微任务（fake timers 下 flushPromises 不推进）
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchAiStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchAiStatus).toHaveBeenCalledTimes(2);

    store.stopPolling();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchAiStatus).toHaveBeenCalledTimes(2);
  });
});
