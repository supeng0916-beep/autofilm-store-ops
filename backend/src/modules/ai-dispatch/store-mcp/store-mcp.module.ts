import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { McpGovernorModule } from '../mcp-governor/mcp-governor.module';
import { STORE_MCP_TOKEN } from './store-mcp.constants';
import { StoreMcpController } from './store-mcp.controller';
import { StoreMcpTools } from './store-mcp.tools';

/** 门店 MCP 端点模块（M02 Task 1）：四工具只读店级脱敏视图。
 * PrismaService 由全局 PrismaModule 提供；无用户会话语境，鉴权在控制器内完成（Bearer 网关令牌）。
 * McpGovernorModule（F07/F11）：tools/call 归属在途任务、≤3 次硬限与逐条审计。 */
@Module({
  imports: [McpGovernorModule],
  controllers: [StoreMcpController],
  providers: [
    StoreMcpTools,
    {
      provide: STORE_MCP_TOKEN,
      inject: [ConfigService],
      // 缺省 ''：WG_MCP_TOKEN 未配置时端点 fail-closed（一律 401），不影响其余业务启动
      useFactory: (config: ConfigService) => config.get<string>('WG_MCP_TOKEN') ?? '',
    },
  ],
})
export class StoreMcpModule {}
