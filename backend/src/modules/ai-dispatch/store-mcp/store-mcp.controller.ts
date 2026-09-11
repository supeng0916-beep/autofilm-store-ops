import { Body, Controller, Headers, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

import { AuditService } from '../../../common/audit';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { Public } from '../../auth/public.decorator';
import { maskDeep } from '../masker';
import {
  MCP_STORE_CALL_LIMIT,
  McpCallGovernorService,
} from '../mcp-governor/mcp-call-governor.service';
import { STORE_MCP_TOKEN } from './store-mcp.constants';
import { StoreMcpArgError, StoreMcpTools } from './store-mcp.tools';

/**
 * 门店 MCP 端点（M02 Task 1）：POST /api/v1/mcp，streamable-http 子集（JSON-RPC 2.0 over HTTP POST）。
 *
 * 实现形态：手写三方法（initialize / tools/list / tools/call）JSON-RPC 分派，不引 @modelcontextprotocol/sdk——
 * 官方 SDK 的 StreamableHTTPServerTransport 要求严格校验 Accept 头（必须同时含 text/event-stream）、
 * 接管裸响应生命周期（会话/SSE/DELETE），与全局 AllExceptionsFilter/ZodValidationPipe 及
 * 「Accept 只给 application/json 也要放行」的 OpenClaw 客户端兼容要求直接冲突；本端点无会话状态，
 * 按 MCP 规范「服务端可用 application/json 应答无状态请求」手写更可控。
 *
 * 鉴权：调用方是网关不是人——不挂用户 JWT（@Public），改用 Bearer 网关令牌（WG_MCP_TOKEN），
 * 未配置或不匹配一律 401（fail-closed），比较走 timingSafeEqual 防时序侧信道。
 */
const PROTOCOL_VERSION = '2025-03-26';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const SERVER_INFO = { name: 'wg-store-mcp', version: '1.0.0' };

/** 未知方法信号：dispatch 抛出、handle 捕获后映射 -32601（与入参错误 -32602 区分） */
class RpcMethodNotFound extends Error {}

interface JsonRpcRequestShape {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

@Controller('mcp')
export class StoreMcpController {
  constructor(
    private readonly tools: StoreMcpTools,
    @Inject(STORE_MCP_TOKEN) private readonly gatewayToken: string,
    private readonly governor: McpCallGovernorService,
    private readonly audit: AuditService,
  ) {}

  /** 单一 POST 入口：协议错误用 JSON-RPC error（HTTP 200），鉴权错误直接 HTTP 401 */
  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<unknown> {
    this.assertAuthorized(authorization);

    const req = body as JsonRpcRequestShape | null;
    if (!req || typeof req !== 'object' || Array.isArray(req) || typeof req.method !== 'string') {
      // 非对象/批量数组/缺 method：按 JSON-RPC 规范回 -32600（id 未知故为 null）
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const id = req.id ?? null;
    try {
      const result = await this.dispatch(req.method, req.params);
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      if (err instanceof RpcMethodNotFound) {
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
      }
      if (err instanceof StoreMcpArgError) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Invalid params: ${err.message}` },
        };
      }
      throw err; // 工具执行期的未知异常交全局过滤器（500 + 日志）
    }
  }

  /** 三方法分派 */
  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === 'initialize') {
      const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion =
        typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : PROTOCOL_VERSION;
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      };
    }
    if (method === 'tools/list') {
      return { tools: this.tools.specs };
    }
    if (method === 'tools/call') {
      const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof p.name !== 'string' || p.name === '') {
        throw new StoreMcpArgError('tools/call 缺少工具名 name');
      }
      const args = p.arguments === undefined || p.arguments === null ? {} : p.arguments;
      if (typeof args !== 'object' || Array.isArray(args)) {
        throw new StoreMcpArgError('arguments 须为对象');
      }
      // F07 硬限次（2026-09-08）：SKILL.md「单次回答 ≤3 次」此前仅提示词软约束（deep-7
      // 实测 6 次无人拦）——超限调用不执行，返回 isError 工具结果引导按已有信息作答。
      // F11 审计补链：网关侧 tool_action 不含 MCP 调用（openclaw bundle-mcp 执行路径不发
      // tool.execution.* 诊断事件，上游限制）——本端点逐条落库审计（含归属任务与入参脱敏
      // 摘要），使「以审计证调用」在后端链路成立。
      const attribution = this.governor.recordCall();
      const auditAfter = {
        tool: p.name,
        args: maskDeep(args),
        attributedTaskId: attribution.taskId,
        callIndex: attribution.callIndex,
        overLimit: attribution.overLimit,
      };
      if (attribution.overLimit) {
        await this.audit.record({
          action: 'ai.mcp.call_rejected',
          objectType: 'ai_task',
          objectId: attribution.taskId ?? 'mcp-unattributed',
          after: auditAfter,
        });
        return {
          content: [
            {
              type: 'text',
              text: `已达到本次任务门店查询上限（${MCP_STORE_CALL_LIMIT} 次），本次查询未执行。请基于已获得的信息回答；信息不足的部分如实说明，不要再尝试查询。`,
            },
          ],
          isError: true,
        };
      }
      try {
        const text = await this.tools.call(p.name, args as Record<string, unknown>);
        await this.audit.record({
          action: 'ai.mcp.tool_call',
          objectType: 'ai_task',
          objectId: attribution.taskId ?? 'mcp-unattributed',
          after: auditAfter,
        });
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        // 执行失败同样留痕（含入参错误）：审计链完整性优先于区分错误形态
        await this.audit.record({
          action: 'ai.mcp.tool_call',
          objectType: 'ai_task',
          objectId: attribution.taskId ?? 'mcp-unattributed',
          after: { ...auditAfter, error: err instanceof Error ? err.message : String(err) },
        });
        throw err;
      }
    }
    throw new RpcMethodNotFound(method);
  }

  /** 网关令牌校验：缺失/未配置/不匹配一律 401；timingSafeEqual 前先比长度防抛错泄漏差异 */
  private assertAuthorized(authorization: string | undefined): void {
    const presented =
      typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice(7)
        : '';
    const expected = this.gatewayToken;
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    const ok = expected !== '' && a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      throw new AppException(ErrorCode.UNAUTHORIZED, 'MCP 网关令牌缺失或不正确');
    }
  }
}
