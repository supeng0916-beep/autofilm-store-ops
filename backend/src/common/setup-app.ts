import { join, resolve, sep } from 'node:path';

import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { static as serveStatic } from 'express';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from 'nestjs-zod';

import { AllExceptionsFilter } from './errors/all-exceptions.filter';

/** 统一装配：main.ts 与测试共用，保证行为一致。
 * rawBody：json body parser verify 钩子留存原始字节，供回调 HMAC 验签（P2 D-P2-4）。
 * 注 1：NestExpressApplication.useBodyParser 的类型定义剔除了 verify 字段，此处断言放行；
 * 运行时 options 会透传给 express.json，行为已用本版本（@nestjs/platform-express 11.1.x）实测验证。
 * 注 2：setupApp 在 app.init() 之前执行，自定义 parser 先于默认 parser 注册，
 * verify 钩子必然生效（body-parser v2 对已读完的请求会跳过二次解析）。 */
export function setupApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  (app as NestExpressApplication).useBodyParser('json', {
    verify: (req: Request, _res: Response, buf: Buffer) => {
      req.rawBody = buf;
    },
  });
  // 生产模式：静态服务前端构建产物（deploy/package.sh 设置 WG_STATIC_DIR 后生效）。
  // 单进程即全系统：浏览器直连后端端口，无需 Vite。SPA history 回退仅兜非 /api 路由。
  // 缓存策略（2026-08-26 门店实测旧包滞留修复）：index.html 必须 no-cache（ETag 再验证），
  // 否则浏览器启发式缓存会把旧版 JS 引用留住——新功能上线后门店看不到（流式/附件卡片曾中招）；
  // /assets/* 为 vite 内容哈希文件名，可 immutable 长缓存。
  const staticDir = process.env.WG_STATIC_DIR;
  if (staticDir) {
    const staticRoot = resolve(staticDir); // 静态服务与 sendFile 都须绝对路径（cwd 无关）
    const instance = app.getHttpAdapter().getInstance() as import('express').Express;
    instance.use(
      serveStatic(staticRoot, {
        setHeaders: (res, path) => {
          if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          } else if (path.includes(`${sep}assets${sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    instance.get(/^(?!\/api\/).*/, (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(staticRoot, 'index.html'));
    });
  }
}
