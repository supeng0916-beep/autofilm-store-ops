import { firstString, toStringArray } from '../ai-dispatch/output-normalize.util';

/** knowledge.search 输出归一化（设计稿 §4.1，2026-08-21）：MiniMax 漂移形态——
 * 别名键/纯文本整体输出/数组当字符串/枚举中文别名/citations 字段缺失。
 * 红线：只翻译不编造；置信度无法识别一律 uncertain（保守）。 */
export function normalizeKnowledgeSearch(raw: unknown): unknown {
  // 纯文本整体输出：视为 answer，置信度保守落 uncertain
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t ? { answer: t, citations: [], confidence: 'uncertain', uncertainReason: null } : raw;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const src = raw as Record<string, unknown>;

  const answer =
    firstString(src, ['answer', '回答', '回复', 'response', 'reply', 'content']) ??
    (Array.isArray(src.answer) ? toStringArray(src.answer).join('\n') || undefined : undefined);

  const citationsRaw = src.citations ?? src['来源'] ?? src['引用'];
  const citations = Array.isArray(citationsRaw)
    ? citationsRaw
        .map((c): Record<string, unknown> | null => {
          if (!c || typeof c !== 'object') return null;
          const o = c as Record<string, unknown>;
          const title = firstString(o, ['title', '标题']);
          if (!title) return null; // 无标题的引用条目无效，剔除
          return {
            title,
            kind: firstString(o, ['kind', '类型']) ?? 'unknown',
            source: typeof o.source === 'string' ? o.source : null,
            version: typeof o.version === 'number' ? o.version : 0,
          };
        })
        .filter((x): x is Record<string, unknown> => x !== null)
    : [];

  const reason = src.uncertainReason ?? src['不确定原因'];
  return {
    answer,
    citations,
    confidence: normalizeConfidenceEnum(src.confidence ?? src['置信度']),
    uncertainReason: typeof reason === 'string' ? reason : null,
  };
}

/** 置信度枚举归一（设计稿 §4.1）：无法识别一律 uncertain——绝不虚报高置信 */
function normalizeConfidenceEnum(rawVal: unknown): string {
  if (typeof rawVal === 'string') {
    const v = rawVal.trim().toLowerCase();
    if (v === 'high' || v === '高') return 'high';
    if (v === 'medium' || v === 'mid' || v === '中') return 'medium';
    if (v === 'low' || v === '低') return 'low';
  }
  return 'uncertain';
}
