import { describe, expect, it } from 'vitest';

import { extractReplyPrefix } from './reply-stream.util';

/** 流式回复提取（纯函数）：模型累计原文 → 可安全展示的 reply 前缀 */
describe('extractReplyPrefix', () => {
  it('空串与无内容返回空', () => {
    expect(extractReplyPrefix('')).toBe('');
    expect(extractReplyPrefix('{')).toBe('');
    expect(extractReplyPrefix('{"reply":')).toBe('');
  });

  it('JSON 生成中：返回 reply 值的已生成前缀', () => {
    expect(extractReplyPrefix('{"reply":"你')).toBe('你');
    expect(extractReplyPrefix('{"reply":"你好，这是话术')).toBe('你好，这是话术');
  });

  it('值闭合后返回完整值（多余内容不影响）', () => {
    expect(extractReplyPrefix('{"reply":"你好","suggestions":["a"]}')).toBe('你好');
  });

  it('转义解码：\\n \\" \\uXXXX', () => {
    expect(extractReplyPrefix('{"reply":"a\\nb')).toBe('a\nb');
    expect(extractReplyPrefix('{"reply":"说\\"贴膜\\"')).toBe('说"贴膜"');
    expect(extractReplyPrefix('{"reply":"\\u4f60好')).toBe('你好');
  });

  it('键名漂移（answer/text）同样提取', () => {
    expect(extractReplyPrefix('{"answer":"DM04')).toBe('DM04');
    expect(extractReplyPrefix('{"text":"话术')).toBe('话术');
  });

  it('非 JSON 开头（推理文字/纯文本/空白前缀）不流式，返回空等终稿', () => {
    expect(extractReplyPrefix('先分析一下{"reply":"x')).toBe('');
    expect(extractReplyPrefix('你好呀，这是纯文本回复')).toBe('');
    expect(extractReplyPrefix('  \n{"reply":"缩进')).toBe('缩进');
  });

  it('markdown 围栏剥离后提取', () => {
    expect(extractReplyPrefix('```json\n{"reply":"好')).toBe('好');
    expect(extractReplyPrefix('```\n{"reply":"围栏')).toBe('围栏');
  });

  it('reply 不在首位：跳过 suggestions 数组后再提取', () => {
    expect(extractReplyPrefix('{"suggestions":["问1","问2"],"reply":"晚到')).toBe('晚到');
  });

  it('非字符串值（数字/对象）：不流式', () => {
    expect(extractReplyPrefix('{"reply":123')).toBe('');
    expect(extractReplyPrefix('{"reply":{"a":1')).toBe('');
  });

  it('顶层对象闭合仍无目标键：返回空', () => {
    expect(extractReplyPrefix('{"confidence":"medium"}')).toBe('');
  });
});
