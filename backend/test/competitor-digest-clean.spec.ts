import { describe, expect, it } from 'vitest';

import { extractChineseDigest } from '../src/modules/marketing/competitor-daily.service';

/** 日报中文抽取（2026-08-28 Q1）：英文思维链行剔除、中文行重建、CJK 占比不足拒收。 */
describe('extractChineseDigest（日报清洗）', () => {
  it('2026-08-28 实况形态：中文短句+英文思维链混排 → 仅留中文行', () => {
    const raw = [
      '我来联网搜索本地贴膜动态。Let me search for more recent news.',
      'I now have a comprehensive picture of the Foshan auto film industry.',
      '',
      '• 今日未检索到可核实的本地新店开业；同行内容竞争集中在授权与施工卖点（来源：八方资源网）。',
      '• 某店推出 DM04 组合促销，型号 DM04 前挡（来源：xxx.com）。',
    ].join('\n');
    const out = extractChineseDigest(raw);
    expect(out).not.toContain('Let me');
    expect(out).not.toContain('I now have');
    expect(out).toContain('今日未检索到');
    expect(out).toContain('DM04');
  });

  it('几乎全英文（CJK<50%）→ 空串拒收', () => {
    expect(
      extractChineseDigest('Search complete. Filtering results. Formatting report. Done.'),
    ).toBe('');
  });

  it('正常中文日报原样保留（截 1500）', () => {
    const raw = '同行动态日报：① XX 店开业促销（来源：a.com）\n② 行业新品发布（来源：b.com）';
    expect(extractChineseDigest(raw)).toBe(raw);
  });
});
