import { describe, expect, it } from 'vitest';

import { normalizeLeadSummary } from '../src/modules/lead/ai/lead-normalize';
import { LeadSummaryOutputSchema } from '../src/modules/lead/ai/lead-ai.module';

/** lead.summary 归一化单测（完全合成的格式回归夹具）：模型前导英文独白 + 内嵌 JSON
 * 两种形态都必须救成合法输出——独白不得进入摘要正文。 */
describe('normalizeLeadSummary 独白剥离（合成回归）', () => {
  it('英文独白+内嵌 JSON（无围栏，合成格式输入）→ 提取 JSON 且摘要无独白', () => {
    const raw =
      'I\'ll read the skill file first as required.{"summary":"线上演示客户咨询DM90演示服务，尚未确定到店时间","concerns":["价格"],"questionsToAsk":[],"nextAction":"邀约到店"}';
    const out = normalizeLeadSummary(raw) as Record<string, unknown>;
    const parsed = LeadSummaryOutputSchema.safeParse(out);
    expect(parsed.success).toBe(true);
    expect(String(out.summary)).not.toContain("I'll");
    expect(String(out.summary)).toContain('演示客户');
  });

  it('纯文本前导独白（无 JSON）→ 独白剥除、中文正文保留', () => {
    const raw =
      'I will check the context first. Let me summarize. 客户咨询窗膜组合报价，预算一万内。';
    const out = normalizeLeadSummary(raw) as Record<string, unknown>;
    const parsed = LeadSummaryOutputSchema.safeParse(out);
    expect(parsed.success).toBe(true);
    expect(String(out.summary)).not.toContain('I will');
    expect(String(out.summary)).not.toContain('Let me');
    expect(String(out.summary)).toContain('客户咨询窗膜组合报价');
  });

  it('对象形态 summary 字段带前导独白 → 同样剥除', () => {
    const out = normalizeLeadSummary({
      summary: "I'll read the skill file first as required. 抖音新客，咨询车衣。",
      concerns: [],
      questionsToAsk: [],
      nextAction: '首触跟进',
    }) as Record<string, unknown>;
    expect(String(out.summary)).not.toContain("I'll");
    expect(String(out.summary)).toContain('抖音新客');
  });

  it('正常输出不受影响（回归）', () => {
    const out = normalizeLeadSummary({
      summary: '客户明确本周到店。',
      concerns: ['价格'],
      questionsToAsk: ['颜色偏好'],
      nextAction: '准备样板',
    }) as Record<string, unknown>;
    expect(String(out.summary)).toBe('客户明确本周到店。');
    expect(LeadSummaryOutputSchema.safeParse(out).success).toBe(true);
  });
});
