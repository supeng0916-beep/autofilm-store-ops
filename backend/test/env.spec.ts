import { validateEnv } from '../src/common/config/env.schema';

describe('环境变量校验（P0-02：配置缺失时启动报清晰错误）', () => {
  const valid = {
    NODE_ENV: 'dev',
    WG_PORT: '8000',
    WG_DATABASE_URL: 'postgresql://autofilm:autofilm@localhost:5432/autofilm_dev',
    WG_JWT_SECRET: 'test-only-secret-0246802789abcdef!!',
  };

  it('合法配置解析成功并转换类型', () => {
    const env = validateEnv(valid);
    expect(env.WG_PORT).toBe(8000);
    expect(env.NODE_ENV).toBe('dev');
    expect(env.WG_DEBUG).toBe(false);
  });

  it('缺少必需项时报错并指明字段', () => {
    expect(() => validateEnv({ NODE_ENV: 'dev' })).toThrow(/WG_DATABASE_URL/);
  });

  it('NODE_ENV 非法值被拒绝', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'staging' })).toThrow();
  });

  it("WG_DEBUG='false' 解析为布尔 false（防 z.coerce.boolean() 陷阱）", () => {
    expect(validateEnv({ ...valid, WG_DEBUG: 'false' }).WG_DEBUG).toBe(false);
  });

  it("WG_DEBUG='true' 解析为布尔 true", () => {
    expect(validateEnv({ ...valid, WG_DEBUG: 'true' }).WG_DEBUG).toBe(true);
  });

  it('AI 配置缺省时取默认值（通道未配置是合法状态，D-P3-1）', () => {
    const env = validateEnv(valid);
    expect(env.WG_OPENCLAW_GATEWAY_WS_URL).toBeUndefined();
    expect(env.WG_OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(env.WG_AI_DAILY_BUDGET_FEN).toBe(10000);
    expect(env.WG_AI_TASK_MAX_TOKENS).toBe(20000);
    expect(env.WG_AI_DISPATCH_DEADLINE_S).toBe(300);
  });

  it('AI 密钥过短被拒绝（min16，防弱密钥）', () => {
    expect(() => validateEnv({ ...valid, WG_AI_CALLBACK_SECRET: 'short' })).toThrow(
      /WG_AI_CALLBACK_SECRET/,
    );
  });
});
