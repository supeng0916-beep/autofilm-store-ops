/** LLM 触发不阻塞业务响应（2026-08-27 全流程测试 #1）：写接口里触发的 AI 任务封顶等待
 * CAP_MS——真实网关单任务 5~12 秒、双任务串行 20~45 秒，HTTP 响应跟着挂起会诱发客户端
 * 超时重发（实测同一客资建出 3 条）。封顶后任务继续后台完成，前端靠状态视图轮询看结果
 * （10~20 秒自动刷新的体验口径不变）；测试假网关瞬时完成，race 由任务侧胜出，
 * 既有「返回即 done」的同步断言不受影响。 */
export const LLM_TRIGGER_CAP_MS = 3000;

export function withLlmCap<T>(p: Promise<T>, ms = LLM_TRIGGER_CAP_MS): Promise<T | void> {
  return Promise.race([
    p.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}
