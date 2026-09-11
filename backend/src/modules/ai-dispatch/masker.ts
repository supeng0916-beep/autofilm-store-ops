/** 出适配层脱敏器（规格 §5.4 / A04）：手机号/微信/车牌/住宅地址不出 ai-dispatch。
 * 策略：键名驱动 + 手机号/车牌正则兜底（D-P2-9）。纯函数，无副作用。 */

export const PHONE_RE = /1[3-9]\d{9}/g;
export const PLATE_RE =
  /[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤川青藏琼宁][A-Z][·\s]?[A-HJ-NP-Z0-9]{5,6}/g;
/** 微信内部号（wxid 前缀高度特异，如 wxid-xyz / wxid_abc123），无普通英文/数字误伤风险 */
export const WXID_RE = /wxid[_-][a-z0-9_-]+/gi;
/** 「微信号」标签后接的账号（如「微信号 abcde12345」）；标签语义强，值部分不要求字母开头以覆盖纯数字微信号 */
export const WECHAT_LABEL_RE = /微信号\s*[:：]?\s*[a-zA-Z0-9_-]+/g;

const PHONE_KEYS = ['phone', 'mobile', 'tel', '手机', '手机号', '电话'];
const WECHAT_KEYS = ['wechat', 'weixin', '微信', '微信号'];
const PLATE_KEYS = ['plate', 'platenumber', 'plate_no', '车牌', '车牌号'];
const ADDRESS_KEYS = ['address', 'homeaddress', 'addr', '地址', '住宅地址', '住址'];
const NAME_KEYS = ['name', 'customername', '姓名', '客户姓名', 'trueName'];

export type LeakType = 'phone' | 'wechat' | 'plate' | 'address' | 'name';
export interface LeakHit {
  path: string;
  type: LeakType;
}

function keyOf(key: string): string {
  return key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
}

/** 实体名键豁免（R2-05 修复，2026-09-09 二轮复验实锤）：*name 后缀默认按人名打码
 * （A04 先例），但门店/品牌/公司等是公开经营信息——storeName"AutoFilm Demo"
 * 被打成「佛客户」，GEO 诊断对象无法确认只能靠模型猜。实体键豁免人名打码，内容
 * 正则兜底照跑（实体值里夹带的电话/车牌仍打码）；账号标识（username/nickname/
 * displayName）与人名键（customerName/technicianName/裸 name）维持既有打码不放水。
 * classifyKey 是 maskDeep 与 scanForLeaks 的共同判据，一处修改两路同口径。 */
const ENTITY_NAME_RE =
  /^(store|shop|company|corp|brand|business|merchant|org|organization|team|platform|product|item|project|campaign|activity)name$/;

function classifyKey(key: string): LeakType | null {
  const k = keyOf(key);
  if (PHONE_KEYS.some((p) => k.includes(p))) return 'phone';
  if (WECHAT_KEYS.some((p) => k.includes(p))) return 'wechat';
  if (PLATE_KEYS.some((p) => k.includes(p))) return 'plate';
  if (ADDRESS_KEYS.some((p) => k.includes(p))) return 'address';
  if (NAME_KEYS.some((p) => k === p || k.endsWith(p))) {
    return ENTITY_NAME_RE.test(k) ? null : 'name';
  }
  return null;
}

/** name 键走 maskName 而非占位符（P2 终审 triage）：PLACEHOLDER 不含 name 键，剔除死代码 */
const PLACEHOLDER: Record<Exclude<LeakType, 'name'>, string> = {
  phone: '[PHONE]',
  wechat: '[WECHAT]',
  plate: '[PLATE]',
  address: '[ADDRESS]',
};

/** 姓名脱敏（规格 §5.4）：保留姓氏 + 先生/女士；性别未知用「客户」 */
export function maskName(name: string, gender?: 'male' | 'female'): string {
  const surname = [...name.trim()][0] ?? 'X';
  const suffix = gender === 'male' ? '先生' : gender === 'female' ? '女士' : '客户';
  return `${surname}${suffix}`;
}

/** lastIndex 策略（D-P2-9）：PHONE_RE/PLATE_RE 为模块级共享、带 g 标志的正则。
 * - replaceAll 走 RegExp[Symbol.replace]，内部会先重置 lastIndex，无状态污染；
 * - test() 会推进 lastIndex，故 scanForLeaks 每次 test 后立即重置。
 * 复用同一正则而非每次新建，避免高频脱敏时的重复编译开销。 */
function maskStringByContent(value: string): string {
  return value
    .replaceAll(PHONE_RE, '[PHONE]')
    .replaceAll(PLATE_RE, '[PLATE]')
    .replaceAll(WXID_RE, '[WECHAT]')
    .replaceAll(WECHAT_LABEL_RE, '[WECHAT]');
}

/** 非空标量（修复环 R1）：字符串须非空；number/boolean/bigint 无「空」概念一律视为非空。
 * 敏感键下的非字符串标量（如 JSON number 型手机号）同样必须脱敏，不得穿透出适配层。 */
function isNonEmptyScalar(v: unknown): v is string | number | boolean | bigint {
  return (
    (typeof v === 'string' && v.length > 0) ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    typeof v === 'bigint'
  );
}

/** 递归脱敏：返回新对象，不改原值 */
export function maskDeep(value: unknown, path = '$'): unknown {
  if (typeof value === 'string') return maskStringByContent(value);
  if (Array.isArray(value)) return value.map((v, i) => maskDeep(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const type = classifyKey(k);
      if (type && isNonEmptyScalar(v)) {
        out[k] = type === 'name' ? maskName(String(v)) : PLACEHOLDER[type];
      } else {
        out[k] = maskDeep(v, `${path}.${k}`);
      }
    }
    return out;
  }
  return value;
}

/** 与 maskName 输出的契约：「姓 + 先生/女士/客户」是已脱敏姓名形态（规格 §5.4），
 * 泄漏扫描的键名命中分支须放行，否则脱敏后载荷会被误判泄漏（Task 5 降级误报）。 */
const MASK_NAME_SUFFIXES = ['先生', '女士', '客户'];
function isMaskedName(value: string): boolean {
  return MASK_NAME_SUFFIXES.some((suffix) => value.endsWith(suffix));
}

/** 已脱敏形态判定：方括号占位符对所有敏感类型生效；先生/女士/客户 后缀形态
 * 仅 name 键豁免——maskDeep 只对 name 键产出该形态，其他键（如 wechat）
 * 豁免只会扩大漏报面（如微信昵称「某某客户」）。 */
function isMaskedValue(type: LeakType, value: string | number | boolean | bigint): boolean {
  if (typeof value !== 'string') return false;
  if (value.startsWith('[')) return true;
  return type === 'name' && isMaskedName(value);
}

/** 泄漏扫描：masker 的只读对偶——找出仍含敏感特征的位置（供提交前断言与 P6 复用） */
export function scanForLeaks(value: unknown, path = '$'): LeakHit[] {
  const hits: LeakHit[] = [];
  const walk = (v: unknown, p: string): void => {
    if (typeof v === 'string') {
      if (PHONE_RE.test(v)) hits.push({ path: p, type: 'phone' });
      PHONE_RE.lastIndex = 0; // g 标志 + test() 复用：立即重置防 lastIndex 状态污染漏检
      if (PLATE_RE.test(v)) hits.push({ path: p, type: 'plate' });
      PLATE_RE.lastIndex = 0;
      if (WXID_RE.test(v)) hits.push({ path: p, type: 'wechat' });
      WXID_RE.lastIndex = 0;
      if (WECHAT_LABEL_RE.test(v)) hits.push({ path: p, type: 'wechat' });
      WECHAT_LABEL_RE.lastIndex = 0;
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${p}[${i}]`));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        const type = classifyKey(k);
        if (type && isNonEmptyScalar(item) && !isMaskedValue(type, item)) {
          hits.push({ path: `${p}.${k}`, type });
        } else {
          walk(item, `${p}.${k}`);
        }
      }
    }
  };
  walk(value, path);
  return hits;
}
