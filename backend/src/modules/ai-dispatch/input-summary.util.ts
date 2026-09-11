// backend/src/modules/ai-dispatch/input-summary.util.ts
/** inputSummary 生成（F03 源头修复，2026-09-08 phase12 评测归因）：
 * 旧实现 JSON.stringify(payload).slice(0,2000) 把超长载荷硬截断成非法 JSON，
 * 连带两处退化：① 回声豁免解析失败退化为整串扫描——knowledgeContext/history/
 * lintFeedback 里的极限词被误当「用户本轮原词」放行顺从性广告（F03 实锤）；
 * ② 手动 retry 以 JSON.parse(inputSummary) 重放载荷（ai-dispatch.service），
 * 截断态只能退化为 {retriedFrom} 占位，重放语义丢失。
 * 现在：不超长原样序列化（既有语义零变化）；超长时字段级截断——message（用户
 * 原话，豁免与重放的核心依据）最多保 500 字，其余字段各最多 200 字（对象字段
 * 降级为截断字符串占位），总长仍 ≤2000。常规字段数（chat 载荷 7 字段）下
 * 结果必为合法 JSON；病态多字段时末端 slice 兜底，提取侧另有字段正则 fail-closed。 */

const SUMMARY_MAX = 2000;
const MESSAGE_MAX = 500;
const FIELD_MAX = 200;

export function buildInputSummary(context: Record<string, unknown>): string {
  const full = JSON.stringify(context);
  if (full.length <= SUMMARY_MAX) return full;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    const cap = key === 'message' ? MESSAGE_MAX : FIELD_MAX;
    if (typeof value === 'string') {
      out[key] = value.length > cap ? `${value.slice(0, cap)}…` : value;
    } else if (value === null || typeof value !== 'object') {
      out[key] = value; // 数字/布尔原样；undefined 由 stringify 丢键（与旧行为一致）
    } else {
      const json = JSON.stringify(value);
      out[key] = json.length > cap ? `${json.slice(0, cap)}…` : json;
    }
  }
  return JSON.stringify(out).slice(0, SUMMARY_MAX);
}
