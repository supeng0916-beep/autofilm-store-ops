import { Module } from '@nestjs/common';

import { McpCallGovernorService } from './mcp-call-governor.service';

/** MCP 调用治理叶子模块（F07/F11，2026-09-08）：AiDispatchModule（beginRun/endRun
 * 登记在途任务）与 StoreMcpModule（tools/call 归属计数与审计）共同依赖本模块。
 * 独立叶子模块而非并入任一侧：两模块互不 import（既有裁定：模块级互相 import 在
 * vitest SSR 转换下不稳），依赖方向恒为 两侧 → 本模块，无环。 */
@Module({
  providers: [McpCallGovernorService],
  exports: [McpCallGovernorService],
})
export class McpGovernorModule {}
