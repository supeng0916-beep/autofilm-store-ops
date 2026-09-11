import { describe, expect, it } from 'vitest';

import { signHmac, verifyHmac } from '../src/common/crypto/hmac';

const SECRET = 'unit-test-secret-0246802789abcdef';
const BODY = '{"taskId":"t1"}';
const NOW = 1_700_000_000;

describe('HMAC 签名/验签（P2-03/04）', () => {
  it('正常签名通过', () => {
    expect(verifyHmac(SECRET, BODY, signHmac(SECRET, BODY, NOW), 300, NOW)).toBe(true);
  });
  it('密钥不符拒绝', () => {
    expect(
      verifyHmac('other-secret-0246802789abcdef!!', BODY, signHmac(SECRET, BODY, NOW), 300, NOW),
    ).toBe(false);
  });
  it('body 被篡改拒绝', () => {
    expect(verifyHmac(SECRET, BODY + ' ', signHmac(SECRET, BODY, NOW), 300, NOW)).toBe(false);
  });
  it('超出时间窗拒绝（防重放）', () => {
    expect(verifyHmac(SECRET, BODY, signHmac(SECRET, BODY, NOW - 301), 300, NOW)).toBe(false);
    expect(verifyHmac(SECRET, BODY, signHmac(SECRET, BODY, NOW - 300), 300, NOW)).toBe(true);
  });
  it('fail-closed：头缺失/格式错误/密钥未配置一律拒绝', () => {
    expect(verifyHmac(SECRET, BODY, undefined, 300, NOW)).toBe(false);
    expect(verifyHmac(SECRET, BODY, 'garbage', 300, NOW)).toBe(false);
    expect(verifyHmac(undefined, BODY, signHmac(SECRET, BODY, NOW), 300, NOW)).toBe(false);
  });
});
