import { beforeEach, describe, expect, it, vi } from 'vitest';

import { aftercareApi } from '../aftercare';
import { http } from '../http';

// 整模块 mock http 实例：只断言路径/载荷契约，不发真实请求（沿 api/__tests__/ai.spec 手法）
vi.mock('../http', () => ({
  http: { post: vi.fn() },
}));

describe('api/aftercare 动作端点请求契约（M09 批次1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // I-1 回归：后端 register/markWon 均带 @Body() ZodDTO，无 body 的 POST 会被
  // 全局 ZodValidationPipe 判 400——动作端点必须显式带空对象 {}（与 executeVisit 同口径）
  it('registerWarranty POST register 携带空请求体 {}', async () => {
    vi.mocked(http.post).mockResolvedValue({ data: { id: 'w1', status: 'registered' } });
    await aftercareApi.registerWarranty('w1');
    expect(http.post).toHaveBeenCalledWith('/aftercare/warranty-registrations/w1/register', {});
  });

  it('markReferralWon POST mark-won 携带空请求体 {}', async () => {
    vi.mocked(http.post).mockResolvedValue({ data: { id: 'r1', status: 'won' } });
    await aftercareApi.markReferralWon('r1');
    expect(http.post).toHaveBeenCalledWith('/aftercare/referrals/r1/mark-won', {});
  });
});
