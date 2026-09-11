// backend/test/mcp-governor.spec.ts
import { beforeEach, describe, expect, it } from 'vitest';

import {
  MCP_STORE_CALL_LIMIT,
  McpCallGovernorService,
} from '../src/modules/ai-dispatch/mcp-governor/mcp-call-governor.service';

/** F07（≤3 次硬限制）+ F11（调用可归属审计）的治理核心：无在途任务不限次、
 * 任务内累计计数、超限判定、归属最新 run、endRun 清零。 */
describe('McpCallGovernorService（F07 硬限次归属）', () => {
  let gov: McpCallGovernorService;
  beforeEach(() => {
    gov = new McpCallGovernorService();
  });

  it('无在途任务：调用不归属、不限次（端点健康探测/非任务上下文）', () => {
    for (let i = 0; i < MCP_STORE_CALL_LIMIT + 3; i += 1) {
      const a = gov.recordCall();
      expect(a.taskId).toBeNull();
      expect(a.overLimit).toBe(false);
    }
  });

  it('任务内前 3 次放行并递增计数，第 4 次起 overLimit（deep-7 六连查回归）', () => {
    gov.beginRun('task-a');
    for (let i = 1; i <= MCP_STORE_CALL_LIMIT; i += 1) {
      const a = gov.recordCall();
      expect(a.taskId).toBe('task-a');
      expect(a.callIndex).toBe(i);
      expect(a.overLimit).toBe(false);
    }
    const fourth = gov.recordCall();
    expect(fourth.overLimit).toBe(true);
    expect(fourth.callIndex).toBe(MCP_STORE_CALL_LIMIT + 1);
    // 超限调用继续计数（审计留痕每一次尝试）
    expect(gov.recordCall().callIndex).toBe(MCP_STORE_CALL_LIMIT + 2);
  });

  it('endRun 后计数不再归属该任务；新任务独立计数', () => {
    gov.beginRun('task-a');
    gov.recordCall();
    gov.endRun('task-a');
    expect(gov.activeRuns()).toBe(0);
    expect(gov.recordCall().taskId).toBeNull();

    gov.beginRun('task-b');
    const a = gov.recordCall();
    expect(a.taskId).toBe('task-b');
    expect(a.callIndex).toBe(1); // 全新计数，不继承 task-a
  });

  it('并发 run 归属最新 begin 的任务（宁偏不漏：计数可略偏，绝不放开无限调用）', () => {
    gov.beginRun('task-old');
    gov.beginRun('task-new');
    const a = gov.recordCall();
    expect(a.taskId).toBe('task-new');
  });

  it('同 run 重复 begin 重置计数（重试路径 beginRun 幂等起新计数）', () => {
    gov.beginRun('task-a');
    gov.recordCall();
    gov.recordCall();
    gov.beginRun('task-a');
    expect(gov.recordCall().callIndex).toBe(1);
  });
});
