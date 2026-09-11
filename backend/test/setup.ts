import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { setupApp } from '../src/common/setup-app';
import type { SubmitTaskRequest } from '../src/modules/ai-dispatch/ai-dispatch.protocol';
import {
  OPENCLAW_GATEWAY,
  type GatewayRunResult,
  type OpenClawGateway,
} from '../src/modules/ai-dispatch/gateway.interface';

/** 缺省假网关（P3-05 引入）：集成测试不再触达真实 OpenClaw，避免「分配后自动触发摘要」等新副作用
 * 让 buildApp 系套件退化为真实 WS 连接重试（~1.5s/次）。按 taskType 回显合法输出，
 * 使 lead.summary/hello 等任务在缺省下也能走通 done 态；需要真实/自定义网关的套件自建模块覆盖。 */
class DefaultFakeGateway implements OpenClawGateway {
  submit(request: SubmitTaskRequest): Promise<GatewayRunResult> {
    const output =
      request.taskType === 'lead.summary'
        ? {
            summary: '（fake）客户意向待确认',
            concerns: [],
            questionsToAsk: [],
            nextAction: '待跟进',
          }
        : request.taskType === 'lead.classify'
          ? {
              level: 'pending',
              confidence: 0.5,
              evidence: [],
              missingInfo: ['车型/需求/档期待补'],
            }
          : { greeting: '你好（fake）', model: 'fake' };
    return Promise.resolve({ status: 'done', output });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** 构建与生产引导一致装配的测试应用（全局前缀/过滤器/校验管道）；
 * 可选传入自定义 gateway（如记录提交载荷的假网关），缺省注入 DefaultFakeGateway；
 * extraOverrides 供套件替换其他 provider（如 P6 回放的确定性 Embedding）。 */
export async function buildApp(
  gateway?: OpenClawGateway,
  extraOverrides: Array<{ token: unknown; value: unknown }> = [],
): Promise<INestApplication> {
  process.env.WG_JWT_SECRET ??= 'test-only-secret-0246802789abcdef!!';
  let overridden = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(OPENCLAW_GATEWAY)
    .useValue(gateway ?? new DefaultFakeGateway());
  for (const o of extraOverrides) {
    overridden = overridden.overrideProvider(o.token).useValue(o.value);
  }
  const mod = await overridden.compile();
  const app = mod.createNestApplication();
  setupApp(app);
  await app.init();
  return app;
}
