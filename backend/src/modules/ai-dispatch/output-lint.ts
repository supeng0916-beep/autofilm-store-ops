// backend/src/modules/ai-dispatch/output-lint.ts
/** 通用输出验证器（2026-09-04 agent 底层改造阶段一）：把 SKILL.md 里
 * 可确定性检验的行为规则迁到代码——规则在 prompt 里靠模型自觉（偶尔漏），
 * 在代码里 100% 执行。hard=拦截退回（走重试），soft=放行但留痕。
 * 判据源自两处实测：字母密度>45% 判英文泄漏（competitor-daily 2026-08-28
 * 日报实况，汉字占比会误杀含 URL/型号的正常中文）；极限词为广告法红线。 */

export interface LintIssue {
  rule: string;
  severity: 'hard' | 'soft';
  field: string;
  message: string;
}
export interface LintResult {
  pass: boolean;
  issues: LintIssue[];
}

/** 广告法极限词红线。「第一」带负向前瞻排除序数用法（第一项/第一步/第一
 * 时间等日常表达），只拦自封排名类表述（行业第一/排名第一）——见 spec
 * 「Markdown 语法=soft」用例中「第一项」不得误伤的回归。「位」「名」不进排除类
 * （2026-09-04 顺修）：「行业第一位/第一名」是自封排名而非序数，进排除类会漏检。
 * R2-03 扩类（2026-09-09 二轮复验）：补件/视/波/场/句/版/稿/张/眼/手/层/站/线/口
 * 等序数量词与视角用法（第一件事/第一视角/第一波曾被 hard，正常生成被迫重试）。 */
const BANNED_PATTERNS: Array<{ word: string; re: RegExp }> = [
  { word: '最好', re: /最好/ },
  {
    word: '第一',
    re: /第一(?![项步个次条天周月季年批轮章节阶段时间件视波场句版稿张眼手层站线口])/,
  },
  { word: '顶级', re: /顶级/ },
  { word: '绝对', re: /绝对/ },
  { word: '全网最低', re: /全网最低/ },
  { word: '史上最', re: /史上最/ },
];
const REPLY_SOFT_MAX = 4000;
const ASCII_DENSITY_LIMIT = 0.45;

/** 语境守卫（F04 修复，2026-09-08 phase12 评测归因）：裸子串匹配把解释性拒绝/
 * 引用复述/建议语也 hard 拦（实测误杀："别用绝对"「绝对化用语」"最好尽早锁位"，
 * redline-probes 与 sales B16/A27）。以下四类语境命中降级 soft 留痕：
 * ① 前接否定/指令词（别用/不能/禁止…，近距窗口且不跨句）——解释性拒绝必然复述原词；
 * ② 引号包裹复述（「顶级」/"最好"）——提及词本身而非使用；
 * ③ 元提及后缀（化用语/字眼/这个词/极限词…）——讨论广告法术语；
 * ④ 「最好」专属副词性建议（尽早/尽快/先…）——建议语非最高级宣称。
 * 守卫按命中位置逐处判定：同词任一命中无守卫照旧 hard（"别用「绝对」"混排
 * "服务绝对一流"仍拦）。主动违规形态不受影响：「绝对不让多花」否定在后不在前、
 * 「顶级门店」「最好的贴膜店」均无语境守卫，照旧 hard。 */
const GUARD_NEGATION_BEFORE_RE =
  /(不能|不要|不得|不可|不准|不许|不建议|禁止|严禁|严令|杜绝|请勿|切勿|切忌|拒绝|避免|无法|禁用|忌用|慎用|别用|别说|别写|别讲|别加|千万别|不是|不算|不属于)[^。！？；\n]{0,8}$/;
const GUARD_QUOTE_BEFORE_RE = /[「『“"']$/;
const GUARD_QUOTE_AFTER_RE = /^[」』”"']/;
const GUARD_META_AFTER_RE =
  /^(化用语|化字眼|字眼|用语|一词|这个词|该词|这类词|此类词|这些词|等词|极限词|违禁词|敏感词)/;
const GUARD_ADVICE_AFTER_RE =
  /^(尽早|尽快|提前|先|还是|由|让|安排|确认|到店|联系|沟通|错开|避开|预留|选|挑)/;

/** 枚举拒绝列表守卫（R2-03）：合规提醒常以分隔符列举禁词（"严禁…出现 最低/最便宜/
 * 全网最低"），列表内部命中距禁止词可超近距窗口——命中紧邻列表分隔符（/、｜）且同句
 * 近窗含禁止/否定词才算守卫；无禁止语境的枚举式宣传（"全网最低、史上最优惠"）照旧 hard。 */
const ENUM_SEPARATOR_RE = /[/、｜]/;
const ENUM_BAN_CONTEXT_RE =
  /(严禁|严令|禁止|禁写|禁用|不得|不能|不要|不可|不准|不许|请勿|切勿|切忌|杜绝|拒绝|避免|忌用|慎用|别用|别说|别写)/;

function isGuardedHit(word: string, text: string, idx: number, len: number): boolean {
  const before = text.slice(Math.max(0, idx - 24), idx);
  const after = text.slice(idx + len, idx + len + 6);
  if (GUARD_NEGATION_BEFORE_RE.test(before)) return true;
  if (GUARD_QUOTE_BEFORE_RE.test(before) && GUARD_QUOTE_AFTER_RE.test(after)) return true;
  if (GUARD_META_AFTER_RE.test(after)) return true;
  // 建议语豁免只给「最好」：顶级/绝对等词没有常见副词性用法，放开只会造漏检
  if (word === '最好' && GUARD_ADVICE_AFTER_RE.test(after)) return true;
  const beforeChar = idx > 0 ? text.charAt(idx - 1) : '';
  const afterChar = text.charAt(idx + len);
  if (
    (ENUM_SEPARATOR_RE.test(beforeChar) || ENUM_SEPARATOR_RE.test(afterChar)) &&
    ENUM_BAN_CONTEXT_RE.test(sentenceWindow(text, idx, idx + len))
  ) {
    return true;
  }
  return false;
}

/** 拒绝/解释元话语标记（RF-02 修复，2026-09-09 fixbatch 复验实锤：message 要求
 * "本地第一、全网最低"时顺从宣传仅 soft）：用户原词豁免只应在「输出是解释/拒绝」时
 * 成立——拒绝语中原词近旁几乎必带此类元话语；豁免词命中且同句近窗无标记 = 顺从性
 * 宣传使用，照旧 hard。「用户说过原词」与「输出正确拒绝」不是同一个条件。
 * 收紧口径：不能/不得/禁止等只认言说类动宾搭配（不能写/不得出现…），防
 * 「绝对不能错过」式促销借否定词洗白；改为/换成=替代建议，强拒绝信号。 */
const REFUSAL_MARKER_RE =
  /(广告法|极限词|违禁词?|敏感词|违规|违法|处罚|罚款|限流|夸大|不实|不能(用|写|说|讲|出现|这么|这样)|不得(使用|出现|写)|不可(用|写)|不准(用|写)|禁止(使用|出现)|请勿|切勿|避免(使用|出现)|改为|换成|慎用)/;
const SENTENCE_BOUND_RE = /[。！？；\n]/;

/** 命中所在同句窗口（±24 字上限、以句读截断）：拒绝标记只在同一句内才算数——
 * 「全网最低是极限词不能写；不过本店价格全网最低」的前句元话语不得洗白后句宣传。 */
function sentenceWindow(text: string, start: number, end: number): string {
  let lo = start;
  for (let i = start - 1; i >= 0 && start - i <= 24; i -= 1) {
    lo = i;
    if (SENTENCE_BOUND_RE.test(text[i])) {
      lo = i + 1;
      break;
    }
  }
  let hi = end;
  for (let i = end; i < text.length && i - end <= 24; i += 1) {
    hi = i + 1;
    if (SENTENCE_BOUND_RE.test(text[i])) {
      hi = i;
      break;
    }
  }
  return text.slice(lo, hi);
}

/** 词级宣传性使用判定：存在「非守卫语境」命中即 true；豁免词额外过拒绝标记窗——
 * 同句近窗含元话语标记视为解释性回声（soft），无标记的主动使用仍算宣传命中（hard）。
 * g 副本由 source 重建（模块级常量保持无 g——文件既有约定，防 lastIndex 污染）。 */
function hasPromotionalHit(
  p: { word: string; re: RegExp },
  text: string,
  isExempt: boolean,
): boolean {
  for (const m of text.matchAll(new RegExp(p.re.source, 'g'))) {
    const idx = m.index ?? 0;
    if (isGuardedHit(p.word, text, idx, m[0].length)) continue;
    if (isExempt && REFUSAL_MARKER_RE.test(sentenceWindow(text, idx, idx + m[0].length))) {
      continue; // 拒绝/解释语境的原词回声：豁免成立
    }
    return true;
  }
  return false;
}

/** 汉字有无判据（薄函数，2026-09-04 Task3 归一）：R1 与 competitor-daily
 * 日报清洗（extractChineseDigest 行/句级过滤）共用同一来源——判据只此一份，
 * 改阈值/正则两处同步生效。 */
export function hasCjkText(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

/** 英文字母密度超限判据（薄函数，同上共用）：字母数/总长 > 45% 视为剩余内容
 * 仍以英文为主（思维链泄漏残留）。判据用「字母密度」而非「汉字占比」：
 * 正常中文日报含 URL/型号/全角标点，纯汉字占比仅 ~45%，汉字占比会误杀。 */
export function exceedsAsciiDensity(text: string): boolean {
  const asciiLetters = (text.match(/[A-Za-z]/g) ?? []).length;
  return asciiLetters / text.length > ASCII_DENSITY_LIMIT;
}

/** 极限词命中提取（2026-09-07 M02 阶段二回声豁免）：返回文本命中的极限词原词
 * （BANNED_PATTERNS 的规范词表口径），供 postLint 调用方从用户输入提取豁免表——
 * 用户让「加上行业第一这种词」时，模型的正确行为是解释拒绝（必然复述原词），
 * 原词命中不该被 R3 hard 拦成任务失败。 */
export function bannedWordsIn(text: string): string[] {
  if (!text) return [];
  return BANNED_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.word);
}

export function lintAgentOutput(
  fields: Record<string, string>,
  opts: { replyField?: string; exemptWords?: string[] } = {},
): LintResult {
  const replyField = opts.replyField ?? 'reply';
  // 豁免表不限于词表本身（调用方传什么豁免什么），但只对 R3 生效；空表=行为与原先一致
  const exempt = new Set(opts.exemptWords ?? []);
  const issues: LintIssue[] = [];
  for (const [field, text] of Object.entries(fields)) {
    if (typeof text !== 'string' || !text.trim()) continue;
    // R1 中文密度（hard）：整段几乎无汉字=英文思维链泄漏（判据与日报清洗同源）
    if (!hasCjkText(text) || (text.length >= 20 && exceedsAsciiDensity(text))) {
      issues.push({
        rule: 'cjk-density',
        severity: 'hard',
        field,
        message: '输出非简体中文（疑似思维链泄漏）',
      });
    }
    // R2 Markdown 语法（soft）：聊天 UI 按纯文本渲染会原样显示
    if (/(\*\*|(?<=\n)#{1,4}\s|```|^\|.{3,}\|$)/m.test(text)) {
      issues.push({
        rule: 'markdown-syntax',
        severity: 'soft',
        field,
        message: '含 Markdown 语法（聊天界面会原样显示）',
      });
    }
    // R3 广告法极限词（hard）；两类降级 soft 留痕不拦截：语境守卫命中=否定指令/引用/
    // 元提及/建议语（F04 修复）、exemptWords 命中且处拒绝/解释语境=用户输入原词回声
    // （2026-09-07 M02 阶段二；RF-02 收紧——豁免不再跳过主动使用判定，顺从性宣传
    // 即使用户说过原词照旧 hard）。豁免与守卫只作用于本规则，不影响 R1/R2/R4；
    // 混排输出（既有回声又有宣传使用）仍拦截。回声口径优先于守卫口径
    // （同一词两者都命中时留痕文案报回声，保持既有断言语义）。
    const bannedHits = BANNED_PATTERNS.filter((p) => p.re.test(text));
    const hardHit = bannedHits.find((p) => hasPromotionalHit(p, text, exempt.has(p.word)));
    if (hardHit) {
      issues.push({
        rule: 'banned-words',
        severity: 'hard',
        field,
        message: `含广告法极限词「${hardHit.word}」`,
      });
    } else if (bannedHits.length > 0) {
      for (const hit of bannedHits) {
        issues.push({
          rule: 'banned-words',
          severity: 'soft',
          field,
          message: exempt.has(hit.word)
            ? `含广告法极限词「${hit.word}」（用户输入原词回声，降级留痕）`
            : `含广告法极限词「${hit.word}」（否定/引用/建议语境，降级留痕）`,
        });
      }
    }
    // R4 超长（soft）：字数预算只约束回复字段（opts.replyField 指定，默认 reply）
    if (field === replyField && text.length > REPLY_SOFT_MAX) {
      issues.push({
        rule: 'length-limit',
        severity: 'soft',
        field,
        message: `超 ${REPLY_SOFT_MAX} 字（冗长风险）`,
      });
    }
  }
  return { pass: !issues.some((i) => i.severity === 'hard'), issues };
}
