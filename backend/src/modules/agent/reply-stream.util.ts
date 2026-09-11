/** 流式回复提取（2026-08-26 老板要求 AI 回复流式输出）：
 * 网关 assistant 事件给的是模型累计原文，而技能契约输出是 JSON（{"reply":"…"}），
 * 原样下发会把 JSON 语法裸露给用户。本函数从累计原文提取「可安全展示的 reply 前缀」：
 * - 首个非空白字符不是 {（剥前导 ```json 围栏后）→ 返回 ''：推理文字前置/纯文本等形态
 *   不流式，等终稿由 normalize 兜底（与 parseOutput 的「终稿在末尾」口径一致）
 * - 是 { → 定位首个目标键（reply/answer/text/message/content——含 MiniMax 键名漂移形态）
 *   的字符串值，边生成边解码转义返回前缀；值未开始或非字符串返回 ''
 * 单调性：累计原文只增长，正常情况下前缀只追加；模型重写导致回退时调用方以更长者为准。 */

const TARGET_KEYS = new Set(['reply', 'answer', 'text', 'message', 'content']);
const WS = new Set([' ', '\t', '\n', '\r']);

export function extractReplyPrefix(raw: string): string {
  if (!raw) return '';
  let body = raw.replace(/^\s+/, '');
  const fence = body.match(/^```(?:json)?\s*/);
  if (fence) body = body.slice(fence[0].length);
  if (!body.startsWith('{')) return '';

  let depth = 0;
  let inStr = false;
  let esc = false;
  let keyToken = '';
  let readingKey = false; // 当前字符串处于键位置（深度1、{ 或 , 之后）
  let keyPosition = false; // 下一个字符串是键
  let expectColon = false;
  let expectValue = false;
  let collecting = false;
  let value = '';

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    if (collecting) {
      if (esc) {
        if (ch === 'u') {
          const hex = body.slice(i + 1, i + 5);
          if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
            value += String.fromCharCode(Number.parseInt(hex, 16));
            i += 4;
          } else {
            value += '\\u';
          }
        } else {
          value += simpleEscape(ch);
        }
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === '"') return value; // 值闭合：前缀即完整值
      value += ch;
      continue;
    }

    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') {
        inStr = false;
        if (readingKey && depth === 1 && TARGET_KEYS.has(keyToken)) expectColon = true;
        readingKey = false;
      } else if (readingKey) keyToken += ch;
      continue;
    }

    if (expectColon) {
      if (ch === ':') {
        expectColon = false;
        expectValue = true;
      } else if (!WS.has(ch)) return value; // 语法意外：按已收集前缀止步
      continue;
    }
    if (expectValue) {
      if (ch === '"') {
        collecting = true;
        expectValue = false;
      } else if (!WS.has(ch)) return value; // 非字符串值：不流式（等终稿）
      continue;
    }

    if (ch === '"') {
      inStr = true;
      readingKey = keyPosition;
      keyPosition = false;
      keyToken = '';
    } else if (ch === '{') {
      depth += 1;
      keyPosition = depth === 1; // 顶层对象的首个键位
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return value; // 对象闭合仍无目标值
    } else if (ch === ',' && depth === 1) {
      keyPosition = true;
    }
  }
  return value; // 流未结束：返回已生成前缀
}

function simpleEscape(ch: string): string {
  switch (ch) {
    case 'n':
      return '\n';
    case 't':
      return '\t';
    case 'r':
      return '\r';
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    default:
      return ch; // \" \\ \/ 及非法转义按原样
  }
}
