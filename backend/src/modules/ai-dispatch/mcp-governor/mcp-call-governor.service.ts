import { Injectable } from '@nestjs/common';

/** 单任务门店查询硬上限（F07 修复，2026-09-08 phase12 评测归因）：SKILL.md 的
 * 「单次回答累计查询 ≤3 次」此前只是提示词软约束——deep-7 实测 6 次调用无人拦截。
 * 现在代码强制：超限调用不执行，返回 isError 工具结果引导模型按已有信息作答。 */
export const MCP_STORE_CALL_LIMIT = 3;

export interface McpCallAttribution {
  /** 归属的在途 AI 任务；无在途任务时 null（非任务上下文的调用不参与限次） */
  taskId: string | null;
  /** 该任务内的累计调用序号（从 1 起） */
  callIndex: number;
  /** 超过 MCP_STORE_CALL_LIMIT：调用方应拒绝执行并回 isError */
  overLimit: boolean;
}

/** MCP 调用治理（F07 硬限次 + F11 审计归属）：门店 MCP 端点是无状态 streamable-http
 * （无会话标识），调用与任务的关联在这里建立——AiDispatchService 在 gateway.submit
 * 前后 beginRun/endRun 登记在途任务，端点每次 tools/call 经 recordCall 归属计数。
 * 归属口径：最近开始的在途 run（部署形态单实例、单店任务并发≈1；晨brief与对话偶发
 * 并发时归属最新 run，计数略偏但绝不放开无限调用——宁偏不漏）。endRun 未及调用
 * （进程内异常路径）由 beginRun 顺手清理超时残留（deadline 口径 300s + 余量）。 */
@Injectable()
export class McpCallGovernorService {
  private readonly runs = new Map<string, { seq: number; startedAt: number; calls: number }>();
  private seqCounter = 0;

  beginRun(taskId: string): void {
    const now = Date.now();
    // 残留清理：超过任务 deadline 上限（300s）仍在册的 run 视为泄漏，防 Map 无界增长
    for (const [id, run] of this.runs) {
      if (now - run.startedAt > 330_000) this.runs.delete(id);
    }
    this.seqCounter += 1;
    // seq 而非 startedAt 定序：同毫秒内先后 begin 的两个 run 也要能分出「最新」
    this.runs.set(taskId, { seq: this.seqCounter, startedAt: now, calls: 0 });
  }

  endRun(taskId: string): void {
    this.runs.delete(taskId);
  }

  recordCall(): McpCallAttribution {
    let latestId: string | null = null;
    let latestSeq = -1;
    for (const [id, run] of this.runs) {
      if (run.seq > latestSeq) {
        latestSeq = run.seq;
        latestId = id;
      }
    }
    if (latestId === null) return { taskId: null, callIndex: 0, overLimit: false };
    const run = this.runs.get(latestId);
    if (!run) return { taskId: null, callIndex: 0, overLimit: false };
    run.calls += 1;
    return {
      taskId: latestId,
      callIndex: run.calls,
      overLimit: run.calls > MCP_STORE_CALL_LIMIT,
    };
  }

  /** 在途 run 数（测试/诊断用） */
  activeRuns(): number {
    return this.runs.size;
  }
}
