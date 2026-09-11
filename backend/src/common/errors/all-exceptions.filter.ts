import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

import { AppException } from './app.exception';
import { ErrorCode, ERROR_STATUS } from './error-code';

/** 统一错误响应结构：{ code, message, detail }（全系统唯一，规范 S09） */
interface ErrorBody {
  code: string;
  message: string;
  detail: unknown;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    let status = 500;
    let body: ErrorBody = { code: ErrorCode.INTERNAL, message: '服务器内部错误', detail: null };

    if (exception instanceof AppException) {
      status = ERROR_STATUS[exception.code];
      body = { code: exception.code, message: exception.message, detail: exception.detail };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      if (status === 404) {
        body = { code: ErrorCode.NOT_FOUND, message: '资源不存在', detail: null };
      } else if (status === 400 || status === 422) {
        body = {
          code: ErrorCode.VALIDATION_FAILED,
          message: '入参校验失败',
          detail: exception.getResponse(),
        };
      } else if (status === 401) {
        body = { code: ErrorCode.UNAUTHORIZED, message: '未认证或认证已失效', detail: null };
      } else if (status === 403) {
        body = { code: ErrorCode.FORBIDDEN, message: '无权执行该操作', detail: null };
      } else if (status === 409) {
        body = { code: ErrorCode.CONFLICT, message: '资源状态冲突', detail: null };
      } else {
        body = { code: ErrorCode.INTERNAL, message: exception.message, detail: null };
      }
    } else {
      this.logger.error(
        '未捕获异常',
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    res.status(status).json(body);
  }
}
