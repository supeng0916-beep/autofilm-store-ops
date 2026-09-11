import { ErrorCode } from './error-code';

/** 业务异常：携带错误码，由全局过滤器转为结构化响应 */
export class AppException extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly detail: unknown = null,
  ) {
    super(message);
  }
}
