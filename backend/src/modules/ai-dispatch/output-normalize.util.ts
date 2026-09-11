/** 输出归一化共享工具（2026-08-21，S11 口径）：各技能 normalizer 的公共纯函数。
 * 只做确定性翻译，不编造内容。 */

/** 按序取第一个「非空字符串」字段值（含 trim）；皆无则 undefined */
export function firstString(src: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** 宽容字符串数组：数组逐项序列化+trim 去空；单非空字符串→单元素数组；其余→[]。
 * 对象/嵌套数组元素走 JSON.stringify 忠实转写——String() 会产出 "[object Object]"/"1,2"
 * 垃圾文本混入正文（红线：只翻译不编造）。 */
export function toStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => stringifyItem(x).trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}

/** 单项序列化：原始值直接 String；对象/嵌套数组用 JSON.stringify 保留原样内容 */
function stringifyItem(x: unknown): string {
  return x !== null && typeof x === 'object' ? JSON.stringify(x) : String(x);
}

/** 句边界截断（P3-F02 修复，2026-09-08 phase3 评测归因；RF-04 补三级退让，
 * 2026-09-09 fixbatch 复验实锤：477 字说明首个句号在 200 字后，限内无句读退回
 * 硬截断仍产「不能瞎排」式残句——「≤200」兑现了，「保证完整句子」没兑现）。
 * 三级退让：①限内最后句读（。！？；…或换行，含终止符）→ 完整句子；②限内最后
 * 逗号级子句边界（，、：）+ 省略号 → 子句完整且截断显式可见；③无任何标点 →
 * 硬截 + 省略号。②③的省略号让残段不再冒充完整说明。不超限原样返回，结果恒 ≤max。 */
export function truncateAtSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const sentence = /.*[。！？；…\n]/s.exec(head);
  if (sentence) return sentence[0];
  // 省略号占 1 字：子句边界在 max-1 内找，保证总长 ≤max
  const clauseHead = text.slice(0, Math.max(max - 1, 1));
  const clause = /.*[，、：]/s.exec(clauseHead);
  return `${clause ? clause[0] : clauseHead}…`;
}
