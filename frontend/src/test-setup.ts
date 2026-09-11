/** Vitest 全局前置（vite.config.ts setupFiles）：补齐 localStorage/sessionStorage。
 * Node 26 的实验性 localStorage（需 --localstorage-file 标志）会以 undefined 占位 globalThis，
 * happy-dom 的 window.localStorage 无法覆盖该占位，导致 stores/auth 等依赖 localStorage 的测试报错。
 * 此处统一替换为内存实现，保证测试环境行为确定。 */

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => {
      data.clear();
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, name, {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });
}
