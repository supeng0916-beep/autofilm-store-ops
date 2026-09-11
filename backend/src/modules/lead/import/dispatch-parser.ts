import { z } from 'zod';

import { WECHAT_TYPES } from '../lead.constants';

/** 派发文本解析（纯函数，无 Nest 依赖；D-P3-9 原文与解析器版本留痕）。
 * 字段字典 §3 行式「键：值」结构，按 11 个键匹配；未知行/缺必填只进 warnings，不抛错。 */

/** 虚拟二维码微信号：ewm- 前缀 + 十位数字（字段字典 N 列口径） */
const EWM_RE = /^ewm-\d{10}$/;

/** 派发解析产物 schema（供 service 校验：必填 日期/信息来源/电话或微信） */
export const ParsedDispatchSchema = z
  .object({
    upstreamDispatchNo: z.string().optional(),
    upstreamDispatchAt: z.date(),
    sourcePlatform: z.string().min(1, '信息来源必填'),
    sourceCategory: z.enum(['online', 'offline']),
    acquisitionMethod: z.string().optional(),
    phone: z.string().optional(),
    wechat: z.string().optional(),
    wechatType: z.enum(WECHAT_TYPES).optional(),
    target: z.string().optional(),
    productNeed: z.string().optional(),
    adPlanText: z.string().optional(),
    chatLink: z.string().optional(),
    rawNeed: z.string().optional(),
  })
  .refine((r) => Boolean(r.phone || r.wechat), { message: '电话与微信至少填一项' });

export type ParsedDispatch = z.infer<typeof ParsedDispatchSchema>;

/** 解析中间态：必填项缺失即产生 warning，由 schema 在 service 层最终校验 */
export type DispatchFields = Partial<ParsedDispatch>;

export interface ParsedDispatchResult {
  fields: DispatchFields;
  warnings: string[];
}

/** 字段字典 §3 的 11 个键（键归一化去空白后匹配，兼容「派发 NO」/「派发NO」） */
const KEY = {
  DISPATCH_NO: '派发NO',
  STORE: '门店',
  DATE: '日期',
  SOURCE: '信息来源',
  PHONE: '电话',
  WECHAT: '微信',
  CAR: '车型',
  NEED: '需求',
  AD_PLAN: '广告计划名称',
  CHAT_LINK: '聊天内容链接',
  REMARK: '客资说明',
} as const;

export function parseDispatchText(raw: string): ParsedDispatchResult {
  const warnings: string[] = [];
  const fields: DispatchFields = {};
  let sourceInfo: string | undefined;

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (const line of lines) {
    const idx = findColonIndex(line);
    if (idx < 0) {
      warnings.push(`未知行：${line}`);
      continue;
    }
    const key = normalizeKey(line.slice(0, idx));
    const value = line.slice(idx + 1).trim();

    switch (key) {
      case KEY.DISPATCH_NO:
        fields.upstreamDispatchNo = value || undefined;
        break;
      case KEY.STORE:
        // 门店名：单店部署，识别但不落库（Lead 无对应列）
        break;
      case KEY.DATE: {
        const parsed = parseDispatchDate(value);
        if (parsed) fields.upstreamDispatchAt = parsed;
        else if (value) warnings.push('日期无法解析');
        break;
      }
      case KEY.SOURCE:
        sourceInfo = value || undefined;
        break;
      case KEY.PHONE:
        fields.phone = value || undefined;
        break;
      case KEY.WECHAT: {
        const stripped = stripParenthetical(value);
        if (stripped) {
          fields.wechat = stripped;
          fields.wechatType = EWM_RE.test(stripped) ? 'virtual_ewm' : 'real';
        }
        break;
      }
      case KEY.CAR:
        fields.target = value || undefined;
        break;
      case KEY.NEED:
        fields.productNeed = value || undefined;
        break;
      case KEY.AD_PLAN:
        fields.adPlanText = value || undefined;
        break;
      case KEY.CHAT_LINK:
        fields.chatLink = value || undefined;
        break;
      case KEY.REMARK:
        fields.rawNeed = value || undefined;
        break;
      default:
        warnings.push(`未知行：${line}`);
        break;
    }
  }

  applySource(fields, sourceInfo);

  if (!fields.phone && !fields.wechat) warnings.push('缺电话/微信');
  if (!sourceInfo) warnings.push('缺信息来源');
  if (!fields.upstreamDispatchAt) warnings.push('缺日期');

  return { fields, warnings };
}

/** 信息来源 → 来源归因：含「私信」→ 广告私信；平台识别抖音/小红书/视频号，其余原样；均线上 */
function applySource(fields: DispatchFields, sourceInfo: string | undefined): void {
  if (!sourceInfo) return;
  if (sourceInfo.includes('私信')) fields.acquisitionMethod = '广告私信';
  if (sourceInfo.includes('抖音')) fields.sourcePlatform = '抖音';
  else if (sourceInfo.includes('小红书')) fields.sourcePlatform = '小红书';
  else if (sourceInfo.includes('视频号')) fields.sourcePlatform = '视频号';
  else fields.sourcePlatform = sourceInfo;
  fields.sourceCategory = 'online';
}

/** 首个分隔冒号（兼容全角「：」与半角「:」） */
function findColonIndex(line: string): number {
  const full = line.indexOf('：');
  const half = line.indexOf(':');
  if (full < 0) return half;
  if (half < 0) return full;
  return Math.min(full, half);
}

/** 键归一化：去空白（「派发 NO」≡「派发NO」） */
function normalizeKey(key: string): string {
  return key.replace(/\s+/g, '');
}

/** 日期解析：YYYY-MM-DD[ HH:mm]，空间分隔转 T 后 new Date；失败返回 undefined */
function parseDispatchDate(value: string): Date | undefined {
  const t = value.trim();
  if (!t) return undefined;
  const d = new Date(t.includes('T') ? t : t.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** 微信值剥离括号说明（全角/半角），供 ewm 判定与落库 */
function stripParenthetical(value: string): string {
  return value.replace(/[（(][^（）()]*[）)]/g, '').trim();
}
