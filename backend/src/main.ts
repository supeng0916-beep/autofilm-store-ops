import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import { AppModule } from './app.module';
import { setupApp } from './common/setup-app';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  setupApp(app);
  const config = app.get(ConfigService);
  const port = config.get<number>('WG_PORT') ?? 8000;
  // 使 OnModuleDestroy / OnApplicationShutdown 等生命周期钩子在进程信号（SIGINT/SIGTERM）时触发，
  // WsOpenClawGateway 借此在应用关闭时释放 WS 连接（P3-00）
  app.enableShutdownHooks();
  await app.listen(port);
}

void bootstrap();
