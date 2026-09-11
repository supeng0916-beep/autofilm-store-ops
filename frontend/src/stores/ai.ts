import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { fetchAiStatus, type AiStatus } from '../api/ai';

/** AI 通道状态 store：轮询 /ai/status，供 AppLayout 横幅与各页面降级提示使用（P2-09） */
export const useAiStore = defineStore('ai', () => {
  const status = ref<AiStatus | null>(null);
  const loadFailed = ref(false);
  let timer: ReturnType<typeof setInterval> | null = null;

  const unavailable = computed(
    () => status.value !== null && (!status.value.globalEnabled || !status.value.healthy),
  );
  const notice = computed(() => (unavailable.value ? 'AI 暂不可用，请人工处理' : null));

  async function refresh(): Promise<void> {
    try {
      status.value = await fetchAiStatus();
      loadFailed.value = false;
    } catch {
      // status 拉取失败不弹错（可能正是降级中）；保留上次状态
      loadFailed.value = true;
    }
  }

  function startPolling(intervalMs = 60_000): void {
    void refresh();
    stopPolling();
    timer = setInterval(() => void refresh(), intervalMs);
  }

  function stopPolling(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { status, unavailable, notice, loadFailed, refresh, startPolling, stopPolling };
});
