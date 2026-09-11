import { Body, Controller, Headers, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { AuditService } from '../../common/audit';
import { verifyHmac } from '../../common/crypto/hmac';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { Public } from '../auth/public.decorator';
import { AiCallbackService } from './ai-callback.service';
import { CallbackEnvelopeSchema } from './ai-dispatch.protocol';

/** OpenClaw → NestJS 回调端点（规格 §5.2，P3-00 起保留为测试/echo 模式）。
 * 机器对机器通道：@Public + HMAC 验签。薄封装：验签/信封校验后交 applyEnvelope（与 Gateway 同步闭环同源）。
 * 受理结果统一 200（含幂等 ignored 分支），与规格 §5.2 回调语义一致。 */
@Controller('internal/ai-callback')
export class AiCallbackController {
  constructor(
    private readonly callbacks: AiCallbackService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post(':taskId')
  @HttpCode(HttpStatus.OK)
  async handle(
    @Param('taskId') taskId: string,
    @Body() body: unknown,
    @Headers('x-wg-signature') signature: string | undefined,
    @Req() req: Request,
  ) {
    const secret = this.config.get<string>('WG_AI_CALLBACK_SECRET');
    const raw = req.rawBody?.toString('utf8') ?? '';
    if (!verifyHmac(secret, raw, signature)) {
      await this.audit.record({
        action: 'ai.callback.rejected',
        objectType: 'ai_task',
        objectId: taskId,
        after: { reason: 'signature' },
      });
      throw new AppException(ErrorCode.AI_SIGNATURE_INVALID, '回调签名校验失败');
    }
    const envelope = CallbackEnvelopeSchema.safeParse(body);
    if (!envelope.success) {
      await this.audit.record({
        action: 'ai.callback.rejected',
        objectType: 'ai_task',
        objectId: taskId,
        after: { reason: 'schema' },
      });
      throw new AppException(ErrorCode.VALIDATION_FAILED, '回调信封不符合协议');
    }
    const { task, ignored } = await this.callbacks.applyEnvelope(taskId, envelope.data, 'http');
    return { status: task.status, ignored };
  }
}
