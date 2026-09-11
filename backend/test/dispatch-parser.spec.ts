import { describe, expect, it } from 'vitest';

import { parseDispatchText } from '../src/modules/lead/import/dispatch-parser';

describe('parseDispatchText（派发文本解析纯函数）', () => {
  const fullText = [
    '派发NO：88812345',
    '门店：AutoFilm Demo',
    '日期：2026-08-14 10:20',
    '信息来源：抖音私信',
    '电话：13800000002',
    '微信：ewm-2468027890（虚拟二维码微信号，请点进聊天内容扫码添加）',
    '车型：凯迪拉克XT5',
    '需求：隐形车衣',
    '广告计划名称：AutoFilm Demo-kz-口播素材+混剪-8.10-马',
    '聊天内容链接：https://example.local/chat/abc',
    '客资说明：客户关注质保年限',
  ].join('\n');

  it('完整派发文本解析出全部字段', () => {
    const { fields, warnings } = parseDispatchText(fullText);
    expect(fields.upstreamDispatchNo).toBe('88812345');
    expect(fields.phone).toBe('13800000002');
    expect(fields.wechat).toBe('ewm-2468027890');
    expect(fields.wechatType).toBe('virtual_ewm');
    expect(fields.sourcePlatform).toBe('抖音');
    expect(fields.sourceCategory).toBe('online');
    expect(fields.acquisitionMethod).toBe('广告私信');
    expect(fields.target).toBe('凯迪拉克XT5');
    expect(fields.productNeed).toBe('隐形车衣');
    expect(fields.adPlanText).toBe('AutoFilm Demo-kz-口播素材+混剪-8.10-马');
    expect(fields.chatLink).toBe('https://example.local/chat/abc');
    expect(fields.rawNeed).toBe('客户关注质保年限');
    expect(fields.upstreamDispatchAt).toBeInstanceOf(Date);
    expect(fields.upstreamDispatchAt?.getFullYear()).toBe(2026);
    expect(warnings).toHaveLength(0);
  });

  it('缺电话与微信产生 warning 且不抛错', () => {
    const raw = fullText
      .split('\n')
      .filter((l) => !l.startsWith('电话') && !l.startsWith('微信'))
      .join('\n');
    expect(() => parseDispatchText(raw)).not.toThrow();
    const { warnings } = parseDispatchText(raw);
    expect(warnings).toContain('缺电话/微信');
  });

  it('未知行进入 warnings 不阻断', () => {
    const raw = `${fullText}\n神秘字段：无关内容`;
    const { warnings } = parseDispatchText(raw);
    expect(warnings.some((w) => w.startsWith('未知行'))).toBe(true);
  });

  it('非 ewm 前缀微信识别为 real', () => {
    const raw = fullText.replace(
      '微信：ewm-2468027890（虚拟二维码微信号，请点进聊天内容扫码添加）',
      '微信：wxid_abc123',
    );
    const { fields } = parseDispatchText(raw);
    expect(fields.wechat).toBe('wxid_abc123');
    expect(fields.wechatType).toBe('real');
  });

  it('缺信息来源与日期分别产生 warning', () => {
    const raw = fullText
      .split('\n')
      .filter((l) => !l.startsWith('信息来源') && !l.startsWith('日期'))
      .join('\n');
    const { warnings } = parseDispatchText(raw);
    expect(warnings).toContain('缺信息来源');
    expect(warnings).toContain('缺日期');
  });
});
