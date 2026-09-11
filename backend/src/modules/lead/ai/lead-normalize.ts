import { firstString, toStringArray } from '../../ai-dispatch/output-normalize.util';

/** lead.classify 输出归一化（设计稿 §4.2，2026-08-21）。
 * 红线：意向无法识别一律 pending——绝不误抬等级影响分配。 */
export function normalizeLeadClassify(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const src = raw as Record<string, unknown>;
  // P6 伪造输出防御：classify 约束明令「不使用任何工具」，tool_calls 存在即证明输出源已被
  // 攻击者染指，属注入劫持而非输出漂移，整体拒收（2026-08-21）。混合载荷 { level, tool_calls }
  // 同样危险：zod 默认 strip 未知键，若原样交回会剥离 tool_calls 后采信伪造 level——
  // 故命中时仅返回标记本身，剥离全部可解析键，保证 schema 必拒、绝不放行伪造等级。
  if ('tool_calls' in src) return { tool_calls: src.tool_calls };
  const out: Record<string, unknown> = {
    level: normalizeLevel(src.level ?? src['意向等级'] ?? src['等级']),
    confidence: normalizeConfidenceNumber(src.confidence ?? src['置信度']),
    evidence: toStringArray(src.evidence ?? src['证据']),
    missingInfo: toStringArray(src.missingInfo ?? src['缺失信息']),
  };
  const next = firstString(src, ['nextAction', '下一步', '下一步建议']);
  if (next) out.nextAction = next;
  return out;
}

/** sales.draft_message 输出归一化（设计稿 §4.3）：纯文本视为草稿正文；
 * 别名键找 message；归一后仍无正文则交回 schema 拒收（无正文草稿无意义）。 */
export function normalizeLeadDraft(raw: unknown): unknown {
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t ? { message: t } : raw;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const src = raw as Record<string, unknown>;
  const message =
    firstString(src, ['message', 'draft', 'text', 'content', '草稿', '消息', '正文']) ??
    (Array.isArray(src.message) ? toStringArray(src.message).join('\n') || undefined : undefined);
  const out: Record<string, unknown> = { message };
  const notes = firstString(src, ['notes', '备注']);
  if (notes) out.notes = notes;
  return out;
}

/** 前导模型独白剥离（2026-08-27 O8 复评 o8-04 实况）：模型偶发输出
 * "I'll read the skill file first as required.{"summary":…}" ——英文过程独白紧跟 JSON。
 * 独白句限定纯可打印 ASCII（中文正文一出现即不可能被匹配），最多剥 3 句。 */
const MONOLOGUE_PREFIX_RE =
  /^(?:i'll|i will|let me|okay,?|sure,?|first,?|now )[ -~]{0,200}?[.;]\s*/i;

function stripMonologue(text: string): string {
  let out = text;
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(MONOLOGUE_PREFIX_RE, '');
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/** lead.summary 输出归一化（设计稿 §4.4）：nextAction 缺失时诚实兜底标注，
 * summary 本体缺失不编造（交回 schema 拒收）。 */
export function normalizeLeadSummary(raw: unknown): unknown {
  const fallbackNext = 'AI 未给出下一步建议，请人工判断';
  if (typeof raw === 'string') {
    let t = raw.trim();
    // 内嵌 JSON 提取（2026-08-27 o8-04 实况）：独白+JSON 同串（无围栏）——首个 { 到末个 } 可解析则按对象走
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const embedded: unknown = JSON.parse(t.slice(start, end + 1));
        if (embedded && typeof embedded === 'object' && !Array.isArray(embedded)) {
          return normalizeLeadSummary(embedded);
        }
      } catch {
        // 不是合法 JSON → 继续按纯文本处理
      }
    }
    t = stripMonologue(t);
    return t ? { summary: t, concerns: [], questionsToAsk: [], nextAction: fallbackNext } : raw;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const src = raw as Record<string, unknown>;
  // 对象形态的 summary 字段同样剥前导独白（网关已剥围栏但未剥独白时）
  const rawSummary = firstString(src, [
    'summary',
    '摘要',
    '概况',
    'overview',
    'profile',
    'text',
    '客户情况',
    '客户概况',
  ]);
  const out: Record<string, unknown> = {
    // text 别名（2026-08-26 O8 降级案例）：网关 parseOutput 对无可解析 JSON 的纯叙述文本
    // 落 {text: raw} 兜底——模型确实输出了摘要正文时按其原文采信，不算编造
    summary: rawSummary !== undefined ? stripMonologue(rawSummary) : undefined,
    concerns: toStringArray(src.concerns ?? src['关注点']),
    questionsToAsk: toStringArray(src.questionsToAsk ?? src['应问问题']),
    nextAction:
      firstString(src, ['nextAction', '下一步', '下一步建议', 'next_step']) ?? fallbackNext,
  };
  const pitch = firstString(src, ['visitPitch', '到店理由']);
  if (pitch) out.visitPitch = pitch;
  const hint = firstString(src, ['escalationHint', '升级时机']);
  if (hint) out.escalationHint = hint;
  return out;
}

/** 意向等级归一：high/中/low 别名映射；其余一律 pending（保守） */
function normalizeLevel(rawVal: unknown): string {
  if (typeof rawVal === 'string') {
    const v = rawVal.trim().toLowerCase();
    if (v === 'high' || v === '高') return 'high';
    if (v === 'mid' || v === 'medium' || v === '中') return 'mid';
    if (v === 'low' || v === '低') return 'low';
  }
  return 'pending';
}

/** 置信度数值归一：数字字符串→Number；>1 视为百分制；越界裁剪；无法解析→0.5 中位保守值 */
function normalizeConfidenceNumber(rawVal: unknown): number {
  const n = typeof rawVal === 'number' ? rawVal : typeof rawVal === 'string' ? Number(rawVal) : NaN;
  if (!Number.isFinite(n)) return 0.5;
  const scaled = n > 1 ? n / 100 : n;
  return Math.max(0, Math.min(1, scaled));
}
