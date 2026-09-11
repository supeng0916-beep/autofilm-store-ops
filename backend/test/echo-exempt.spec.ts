// backend/test/echo-exempt.spec.ts
/** F03 修复（2026-09-08，phase12 评测归因）：回声豁免的两处漏洞——
 * ① inputSummary 超 2000 被硬截断成非法 JSON 时，exemptWordsFromSummary 退化为
 *   整串扫描：knowledgeContext/history 里的极限词被误当「用户本轮原词」豁免，
 *   顺从性广告成稿仅 soft 放行（lint-truncated-summary.json 生产函数直接复现）；
 * ② 截断源头：JSON.stringify(payload).slice(0,2000) 必然产非法 JSON，还连带
 *   手动 retry 的 JSON.parse(inputSummary) 重放退化（ai-dispatch.service L243）。
 * 修复口径：豁免表只认 message 字段（截断态用字段正则提取，提不出则 fail-closed
 * 返回空表）；inputSummary 生成改为字段级截断，常规字段数下保持合法 JSON。 */
import { describe, expect, it } from 'vitest';

import { postLintSalesAgentOutput } from '../src/modules/agent/agent.service';
import { buildInputSummary } from '../src/modules/ai-dispatch/input-summary.util';

describe('回声豁免提取（F03-①：截断摘要只认 message，不整串扫描）', () => {
  /** 构造真实形态的截断摘要：message 干净在前，knowledgeContext 带极限词把总长推过 2000 */
  const truncatedWithBannedKnowledge = JSON.stringify({
    persona: 'sales',
    staff: 'ph-sales-ops',
    message: '宝马X5贴车衣多少钱',
    history: [{ role: 'user', content: '在吗' }],
    knowledgeContext:
      '【price】双膜套餐 7600 起，全网最低价保证；' + '窗膜组合报价口径说明。'.repeat(200),
  }).slice(0, 2000);

  it('前置成立：截断摘要确为非法 JSON', () => {
    expect(() => {
      JSON.parse(truncatedWithBannedKnowledge);
    }).toThrow();
  });

  it('knowledgeContext 里的极限词不再被误当用户回声——主动违规仍 hard', () => {
    const r = postLintSalesAgentOutput(
      { reply: '我们是全网最低价，双膜套餐 7600 起。' },
      { inputSummary: truncatedWithBannedKnowledge },
    );
    expect(r.pass).toBe(false);
    expect(r.issues.some((i) => i.rule === 'banned-words' && i.severity === 'hard')).toBe(true);
  });

  it('message 里的极限词照旧豁免回声（截断态解释拒绝仍 soft 放行）', () => {
    const summary = JSON.stringify({
      persona: 'sales',
      staff: 'ph-sales-ops',
      message: '朋友圈文案给我加上全网最低这种说法',
      history: [],
      knowledgeContext: '知识正文填充。'.repeat(400),
    }).slice(0, 2000);
    expect(() => {
      JSON.parse(summary);
    }).toThrow();
    const r = postLintSalesAgentOutput(
      { reply: '全网最低这个说法我不能写，属广告法极限词，建议改为突出十年质保。' },
      { inputSummary: summary },
    );
    expect(r.pass).toBe(true);
    expect(r.issues.every((i) => i.severity === 'soft')).toBe(true);
  });

  it('fail-closed：截断到连 message 字段都提不出时不豁免（宁拦不放）', () => {
    const r = postLintSalesAgentOutput(
      { reply: '我们是全网最低价。' },
      { inputSummary: '{"persona":"sales","staff":"ph","hist' },
    );
    expect(r.pass).toBe(false);
  });

  it('lintFeedback 重试载荷里的极限词不进豁免表（反馈含被拦原词）', () => {
    const summary = JSON.stringify({
      persona: 'sales',
      staff: 'ph-sales-ops',
      message: '给揽胜车主写条报价话术',
      lintFeedback:
        '上轮输出被安全验证器拦截：含广告法极限词「顶级」。请修正该问题后重新输出完整结果。',
      knowledgeContext: '车型报价口径。'.repeat(300),
    }).slice(0, 2000);
    expect(() => {
      JSON.parse(summary);
    }).toThrow();
    const r = postLintSalesAgentOutput(
      { reply: '本店是本地顶级门店，工艺一流。' },
      { inputSummary: summary },
    );
    expect(r.pass).toBe(false);
  });
});

describe('inputSummary 生成（F03-②：超长载荷仍保持合法 JSON、message 完整）', () => {
  it('不超长时原样序列化（既有语义零变化）', () => {
    const ctx = { persona: 'sales', message: '今日排期', knowledgeContext: '空' };
    expect(buildInputSummary(ctx)).toBe(JSON.stringify(ctx));
  });

  it('超长时字段级截断：≤2000、可解析、message 保留完整', () => {
    const message = '宝马X5贴车衣多少钱，另外问下窗膜组合口径'.repeat(4); // <500 字
    const s = buildInputSummary({
      persona: 'sales',
      message,
      history: Array.from({ length: 8 }, (_, i) => ({
        role: 'user',
        content: `第${i}轮`.repeat(60),
      })),
      knowledgeContext: '全网最低等评测合成知识。'.repeat(300),
      structuredContext: { approvals: 3 },
    });
    expect(s.length).toBeLessThanOrEqual(2000);
    const parsed = JSON.parse(s) as Record<string, unknown>; // 不抛=合法 JSON
    expect(parsed.message).toBe(message);
    expect(typeof parsed.knowledgeContext).toBe('string'); // 大字段降级为截断字符串占位
  });

  it('message 自身超长时截断留痕但不破 JSON', () => {
    const s = buildInputSummary({ message: 'm'.repeat(2000), knowledgeContext: 'k'.repeat(2000) });
    expect(s.length).toBeLessThanOrEqual(2000);
    const parsed = JSON.parse(s) as { message: string };
    expect(parsed.message.length).toBeLessThan(2000);
    expect(parsed.message.startsWith('mmmm')).toBe(true);
  });
});
