import { createHmac, timingSafeEqual } from 'node:crypto';

/** HMAC 签名（D-P2-4）：Stripe 式 t + v1 双段头。
 * 签名基 = `${t}.${rawBody}`——时间戳并入签名域，防止头与体拆分重组。 */
export function signHmac(
  secret: string,
  rawBody: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const sig = createHmac('sha256', secret).update(`${nowSeconds}.${rawBody}`).digest('hex');
  return `t=${nowSeconds},v1=${sig}`;
}

/** 验签：fail-closed——密钥缺失/头缺失/格式错误/超时窗/签名不符一律 false（D-P2-4）。
 * timingSafeEqual 前先比长度，避免抛错泄漏时序差异。 */
export function verifyHmac(
  secret: string | undefined,
  rawBody: string,
  header: string | undefined,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret || !header) return false;
  const parts = new Map<string, string>();
  for (const segment of header.split(',')) {
    const eq = segment.indexOf('=');
    if (eq <= 0) return false;
    parts.set(segment.slice(0, eq).trim(), segment.slice(eq + 1).trim());
  }
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(v1);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
