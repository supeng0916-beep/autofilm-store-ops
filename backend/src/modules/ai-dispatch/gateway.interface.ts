import type { SubmitTaskRequest } from './ai-dispatch.protocol';

/** OpenClaw 网关抽象（P3-00 起为 Gateway 协议 WebSocket+RPC 形态，D-P3-1）。
 * 仅 AiDispatchService（submit）与 AiHealthService（health 探测）可注入本 token。 */
export const OPENCLAW_GATEWAY = Symbol('OPENCLAW_GATEWAY');

/** 可识别的超时错误：run 等待超 deadline（网关返回 {status:timeout} 或本地 wait 定时器到期）。
 * submitTask 据此把任务降级为 reason='timeout'，区别于连接/提交失败的「提交失败」（D-P3-1 设计决策 3）。 */
export class OpenClawTimeoutError extends Error {
  constructor(message = 'OpenClaw run 超时') {
    super(message);
    this.name = 'OpenClawTimeoutError';
  }
}

/** 一次 agent run 的归一化结果：与 CallbackEnvelope 同构（少 taskType），经同一 Zod 校验路径。
 * status=done 时 output/usage 由 applyEnvelope 校验/记账；status=failed 时 errorMessage 落库。 */
export interface GatewayRunResult {
  status: 'done' | 'failed';
  output?: unknown;
  usage?: { tokensIn: number; tokensOut: number };
  model?: string;
  costEstimateFen?: number;
  errorMessage?: string;
}

export interface OpenClawGateway {
  /** 发起 agent run 并在同一连接等待结果；deadline 内未完成抛超时错误。
   * onAssistantText（2026-08-26 流式输出）：assistant 流事件到达时回调，参数为累计原文
   * （网关 2026.7.1+ 语义；旧版 delta 分片由实现侧拼接后同样以累计量回调）。 */
  submit(
    request: SubmitTaskRequest,
    onAssistantText?: (cumulativeText: string) => void,
  ): Promise<GatewayRunResult>;
  /** 健康探测：true=可达且鉴权通过 */
  health(): Promise<boolean>;
  /** 释放连接（应用关闭时） */
  close(): Promise<void>;
}
