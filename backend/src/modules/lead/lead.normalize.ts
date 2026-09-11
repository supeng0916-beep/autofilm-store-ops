/** 联系方式归一化（纯函数，无 Nest 依赖）。
 * 去重键口径（D-P3-2 设计决策 1）：电话与微信任一归一化命中即判重，姓名不作判定键。
 * 独立成文件供 dedup.service 与 lead.repository 共用，避免 service↔repository 循环依赖。 */

/** 电话归一化：去空白与连字符，剥离可选 +86 国家码前缀（`+86 138-0000-0003` ≡ `13800000003`） */
export function normalizePhone(raw: string): string {
  return raw.replace(/[\s-]/g, '').replace(/^\+?86/, '');
}

/** 微信归一化：小写 trim（微信号大小写不敏感） */
export function normalizeWechat(raw: string): string {
  return raw.trim().toLowerCase();
}
