import { describe, expect, it, vi } from 'vitest';

import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import { WsOpenClawGateway } from '../src/modules/ai-dispatch/ws-openclaw.gateway';
import { startFakeOpenClawGateway } from './helpers/fake-openclaw-gateway';

const REQUEST = (taskId = 't1'): SubmitTaskRequest => ({
  taskId,
  taskType: 'hello',
  context: { name: 'AutoFilm Demo' },
  constraints: { boundary: '通道验证任务，不得访问任何工具' },
  callbackUrl: `http://localhost:8000/api/v1/internal/ai-callback/${taskId}`,
  deadline: new Date(Date.now() + 5000).toISOString(),
});

describe('WsOpenClawGateway（P3-00，node 内置 WebSocket 客户端 + fake WS 服务端）', () => {
  it('提交后在同一连接收到结果并归一化为 GatewayRunResult', async () => {
    const fake = await startFakeOpenClawGateway({
      token: 'test-token',
      onRun: () => ({
        output: { greeting: 'hi', model: 'MiniMax-M3' },
        usage: { tokensIn: 10, tokensOut: 20 },
        model: 'MiniMax-M3',
      }),
    });
    const gw = new WsOpenClawGateway({ url: fake.url, token: 'test-token', deadlineMs: 5000 });
    try {
      const result = await gw.submit(REQUEST());
      expect(result.status).toBe('done');
      expect(result.output).toEqual({ greeting: 'hi', model: 'MiniMax-M3' });
      expect(result.usage).toEqual({ tokensIn: 10, tokensOut: 20 });
      expect(fake.received).toHaveLength(1);
      // 事件流已带 usage（未来网关版本）→ 不再查 sessions.usage
      expect(fake.usageQueries).toHaveLength(0);
    } finally {
      await gw.close();
      await fake.close();
    }
  });

  it('2026-08-28 P5：事件流无 usage 时经 sessions.usage 回填 token/模型（按事件 sessionKey 查询）', async () => {
    // 真实网关 2026.7.1+ 实测：lifecycle 只有 phase/时间戳，用量在会话落盘、经 sessions.usage RPC 可查
    const fake = await startFakeOpenClawGateway({
      token: 'test-token',
      onRun: () => ({ output: { greeting: '你好，AutoFilm Demo' } }),
      sessionUsage: { input: 17434, output: 129 },
    });
    const gw = new WsOpenClawGateway({ url: fake.url, token: 'test-token', deadlineMs: 5000 });
    try {
      const result = await gw.submit(REQUEST('t-usage'));
      expect(result.status).toBe('done');
      expect(result.usage).toEqual({ tokensIn: 17434, tokensOut: 129 });
      expect(result.model).toBe('MiniMax-M3');
      // 查询键来自事件流 sessionKey（agent:main:explicit:<runId>）
      expect(fake.usageQueries[0]).toMatch(/^agent:main:explicit:run-\d+$/);
    } finally {
      await gw.close();
      await fake.close();
    }
  });

  it('sessions.usage 首查缓存刷新中（usage:null）→ 小步重试后取到', async () => {
    const fake = await startFakeOpenClawGateway({
      token: 'test-token',
      onRun: () => ({ output: { greeting: 'hi' } }),
      sessionUsage: { input: 500, output: 60 },
      usageNullFirst: 2,
    });
    const gw = new WsOpenClawGateway({
      url: fake.url,
      token: 'test-token',
      deadlineMs: 5000,
      usageFetch: { attempts: 5, delayMs: 10 },
    });
    try {
      const result = await gw.submit(REQUEST('t-retry'));
      expect(result.usage).toEqual({ tokensIn: 500, tokensOut: 60 });
      expect(fake.usageQueries).toHaveLength(3);
    } finally {
      await gw.close();
      await fake.close();
    }
  });

  it('sessions.usage 不可用（回错/查不到）→ 不阻断任务结果，usage 留空', async () => {
    const fake = await startFakeOpenClawGateway({
      token: 'test-token',
      onRun: () => ({ output: { greeting: 'hi' } }),
      usageError: true,
    });
    const gw = new WsOpenClawGateway({
      url: fake.url,
      token: 'test-token',
      deadlineMs: 5000,
      usageFetch: { attempts: 2, delayMs: 10 },
    });
    try {
      const result = await gw.submit(REQUEST('t-err'));
      expect(result.status).toBe('done');
      expect(result.output).toEqual({ greeting: 'hi' });
      expect(result.usage).toBeUndefined();
    } finally {
      await gw.close();
      await fake.close();
    }
  });

  it('网关 2026.7.1+ 事件格式（assistant.text=累计全文+delta、chat final 终稿）不产生重复拼接', async () => {
    // P6-02 实测回归：新版网关 assistant.data.text 为累计全文，旧逻辑按增量拼接会把
    // 「{" + 全文」接成非法 JSON → 输出校验必失败。修复后以累计全文/终稿为准。
    const fake = await startFakeOpenClawGateway({
      token: 'test-token',
      streamStyle: 'chunked',
      onRun: () => ({ output: { greeting: '你好，AutoFilm Demo', model: 'MiniMax-M3' } }),
    });
    const gw = new WsOpenClawGateway({ url: fake.url, token: 'test-token', deadlineMs: 5000 });
    try {
      const result = await gw.submit(REQUEST('t-chunked'));
      expect(result.status).toBe('done');
      expect(result.output).toEqual({ greeting: '你好，AutoFilm Demo', model: 'MiniMax-M3' });
    } finally {
      await gw.close();
      await fake.close();
    }
  });

  it('模型终稿为「推理前缀+JSON」混合文本时提取末尾顶层 JSON（MiniMax-M3 实测形态）', async () => {
    // M3 会在严格 JSON 前输出推理文字（P6-02 实测）：整体 JSON.parse 失败不得走 {text} 兜底，
    // 须提取最后一个顶层 JSON 对象作为输出
    const fake = await startFakeOpenClawGateway({
      token: 'test-token',
      onRun: () => ({
        rawText:
          'The skill is clear. Let me analyze {"干扰对象":true} the input:\n\n强证据密度很高，建议 high。\n\n{"level":"high","confidence":0.92,"evidence":["明确车型"],"missingInfo":[]}',
      }),
    });
    const gw = new WsOpenClawGateway({ url: fake.url, token: 'test-token', deadlineMs: 5000 });
    try {
      const result = await gw.submit(REQUEST('t-preamble'));
      expect(result.status).toBe('done');
      expect(result.output).toEqual({
        level: 'high',
        confidence: 0.92,
        evidence: ['明确车型'],
        missingInfo: [],
      });
    } finally {
      await gw.close();
      await fake.close();
    }
  });

  it('token 错误握手即失败（fail-closed）', async () => {
    const fake = await startFakeOpenClawGateway({ token: 'correct-token' });
    const gw = new WsOpenClawGateway({ url: fake.url, token: 'wrong-token', deadlineMs: 5000 });
    try {
      await expect(gw.submit(REQUEST())).rejects.toThrow(/invalid token/);
    } finally {
      await gw.close();
      await fake.close();
    }
  });

  it('run 超 deadline 抛超时错误（fake 不回 agent.wait）', async () => {
    const fake = await startFakeOpenClawGateway({ token: 'test-token', waitMode: 'silent' });
    const gw = new WsOpenClawGateway({ url: fake.url, token: 'test-token', deadlineMs: 200 });
    try {
      await expect(gw.submit(REQUEST())).rejects.toThrow(/超时/);
    } finally {
      await gw.close();
      await fake.close();
    }
  });

  it('health() 在可连接时 true、不可达时 false', async () => {
    const fake = await startFakeOpenClawGateway({ token: 'test-token' });
    const gw = new WsOpenClawGateway({ url: fake.url, token: 'test-token', deadlineMs: 2000 });
    await expect(gw.health()).resolves.toBe(true);
    await gw.close();
    await fake.close();

    const dead = new WsOpenClawGateway({
      url: 'ws://127.0.0.1:1',
      token: 'test-token',
      deadlineMs: 2000,
    });
    await expect(dead.health()).resolves.toBe(false);
    await dead.close();
  });

  it('未配置（空 url/token）→ submit 抛「通道未配置」且 health false（D-P3-1）', async () => {
    const gw = new WsOpenClawGateway({ url: '', token: '' });
    try {
      await expect(gw.submit(REQUEST())).rejects.toThrow(/通道未配置/);
      await expect(gw.health()).resolves.toBe(false);
    } finally {
      await gw.close();
    }
  });

  it('agent.wait 返回 error → 归一化为 failed（errorMessage 落库语义）', async () => {
    const fake = await startFakeOpenClawGateway({ token: 'test-token', waitMode: 'error' });
    const gw = new WsOpenClawGateway({ url: fake.url, token: 'test-token', deadlineMs: 5000 });
    try {
      const result = await gw.submit(REQUEST());
      expect(result.status).toBe('failed');
      expect(result.errorMessage).toContain('执行失败');
    } finally {
      await gw.close();
      await fake.close();
    }
  });

  it('agent.wait 返回 timeout → 抛超时错误（网关侧超时，非客户端本地定时器）', async () => {
    const fake = await startFakeOpenClawGateway({ token: 'test-token', waitMode: 'timeout' });
    const gw = new WsOpenClawGateway({ url: fake.url, token: 'test-token', deadlineMs: 5000 });
    try {
      await expect(gw.submit(REQUEST())).rejects.toThrow(/超时/);
    } finally {
      await gw.close();
      await fake.close();
    }
  });

  it('连接不可达 → 重试耗尽抛错（fail-closed，无任务态副作用）', async () => {
    const gw = new WsOpenClawGateway({
      url: 'ws://127.0.0.1:1',
      token: 'test-token',
      deadlineMs: 2000,
    });
    try {
      await expect(gw.submit(REQUEST())).rejects.toThrow(/连接/);
    } finally {
      await gw.close();
    }
  });

  it('close() 后再次 submit 自动重连（释放连接不破坏可复用性）', async () => {
    const fake = await startFakeOpenClawGateway({ token: 'test-token' });
    const gw = new WsOpenClawGateway({ url: fake.url, token: 'test-token', deadlineMs: 2000 });
    try {
      expect((await gw.submit(REQUEST('t1'))).status).toBe('done');
      await gw.close();
      expect((await gw.submit(REQUEST('t2'))).status).toBe('done');
      expect(fake.received).toHaveLength(2);
    } finally {
      await gw.close();
      await fake.close();
    }
  });

  it('onApplicationShutdown 释放连接：fake 观察到客户端 close 帧（应用关闭生命周期）', async () => {
    const fake = await startFakeOpenClawGateway({ token: 'test-token' });
    const gw = new WsOpenClawGateway({ url: fake.url, token: 'test-token', deadlineMs: 2000 });
    try {
      await gw.submit(REQUEST()); // 建立连接
      expect(fake.closedCount).toBe(0);
      await gw.onApplicationShutdown();
      // 优雅关闭握手完成 → 服务端 socket 收到 close，closedCount 递增
      await vi.waitFor(() => expect(fake.closedCount).toBeGreaterThanOrEqual(1), { timeout: 2000 });
    } finally {
      await gw.close();
      await fake.close();
    }
  });
});
