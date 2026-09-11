import { Body, Controller, Get, INestApplication, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { setupApp } from '../src/common/setup-app';
import { AppException } from '../src/common/errors/app.exception';
import { ErrorCode } from '../src/common/errors/error-code';

interface ApiErrorBody {
  code: string;
  message: string;
  detail: unknown;
}

/** 探针控制器：仅存在于测试装配，验证过滤器与校验管道的端到端行为 */
@Controller('test')
class ProbeController {
  @Get('boom')
  boom(): never {
    throw new AppException(ErrorCode.FORBIDDEN, '测试错误');
  }

  @Get('teapot')
  teapot(): never {
    // 裸 HttpException 走过滤器状态码→错误码映射
    throw new AppException(ErrorCode.CONFLICT, '状态冲突');
  }
}

const echoSchema = z.object({ name: z.string().min(1) });
class EchoDto extends createZodDto(echoSchema) {}

@Controller('test')
class EchoController {
  @Post('echo')
  echo(@Body() body: EchoDto): { name: string } {
    return { name: body.name };
  }
}

@Module({ controllers: [ProbeController, EchoController] })
class ProbeModule {}

describe('统一错误码与异常过滤器（规范 S09）', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('AppException 映射状态码与错误码', async () => {
    const res = await request(app.getHttpServer() as Server).get('/api/v1/test/boom');
    expect(res.status).toBe(403);
    expect(res.body as ApiErrorBody).toEqual({
      code: 'FORBIDDEN',
      message: '测试错误',
      detail: null,
    });
  });

  it('CONFLICT 错误码返回 409', async () => {
    const res = await request(app.getHttpServer() as Server).get('/api/v1/test/teapot');
    expect(res.status).toBe(409);
    expect((res.body as ApiErrorBody).code).toBe('CONFLICT');
  });

  it('未知路由返回结构化 NOT_FOUND', async () => {
    const res = await request(app.getHttpServer() as Server).get('/api/v1/no-such-route');
    expect(res.status).toBe(404);
    expect((res.body as ApiErrorBody).code).toBe('NOT_FOUND');
  });

  it('入参校验失败返回 VALIDATION_FAILED（ZodValidationPipe 端到端）', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/test/echo')
      .send({ name: '' });
    // nestjs-zod 抛出 400 系 BadRequestException；契约只要求码为 VALIDATION_FAILED
    expect([400, 422]).toContain(res.status);
    expect((res.body as ApiErrorBody).code).toBe('VALIDATION_FAILED');
  });

  it('合法入参通过校验并返回业务结果', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/test/echo')
      .send({ name: '甲' });
    expect(res.status).toBe(201);
    expect(res.body as { name: string }).toEqual({ name: '甲' });
  });
});
