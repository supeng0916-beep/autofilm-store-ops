import { describe, expect, it } from 'vitest';

import { applyDealSignalRule } from '../src/modules/lead/ai/lead-ai.module';

/** 成交级信号确定性规则后验（2026-08-27 第二轮回归 #9 实锤：模型证据写「按规则直接判 high」
 * 结论字段却输出 pending——提示词概率约束兜不住，门店定级口径用代码保证）。 */
describe('applyDealSignalRule 分级规则后验（#9）', () => {
  it('上下文含提车时间且模型结论非 high → 校正为 high（置信度抬升+证据留痕）', () => {
    const out = applyDealSignalRule(
      { rawNeed: '问DM04组合价格，下周提车', lastFollowUpResult: null },
      { level: 'pending', confidence: 0.85, evidence: ['主动问价'] },
    );
    expect(out?.level).toBe('high');
    expect(out?.confidence).toBeGreaterThanOrEqual(0.75);
    expect(out?.evidence.some((e) => e.includes('规则校正'))).toBe(true);
  });

  it('已付定金也命中；模型已判 high 则不动作', () => {
    const a = applyDealSignalRule(
      { rawNeed: null, lastFollowUpResult: '客户已付定金500元锁定方案' },
      { level: 'mid', confidence: 0.6 },
    );
    expect(a?.level).toBe('high');

    const b = applyDealSignalRule(
      { rawNeed: '明天提车', lastFollowUpResult: null },
      { level: 'high', confidence: 0.9, evidence: [] },
    );
    expect(b).toBeNull();
  });

  it('无成交级信号不动（普通询价保持原判）', () => {
    const out = applyDealSignalRule(
      { rawNeed: '问问窗膜价格', lastFollowUpResult: null },
      { level: 'mid', confidence: 0.65 },
    );
    expect(out).toBeNull();
  });
});
