import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { AiDispatchModule } from '../ai-dispatch/ai-dispatch.module';
import { AiTaskRegistry } from '../ai-dispatch/ai-dispatch.registry';
import {
  exceedsAsciiDensity,
  hasCjkText,
  lintAgentOutput,
  type LintIssue,
  type LintResult,
} from '../ai-dispatch/output-lint';
import { truncateAtSentence } from '../ai-dispatch/output-normalize.util';

/** 短视频文案输出 schema（marketing.video_copy，V2.1）：口播文案草稿，人采用后自行拍摄/发布；
 * reasoning（T2 决策留痕）：可选 ≤200 字决策说明，落库供门店复盘 */
export const VideoCopyOutputSchema = z.object({
  title: z.string().min(1),
  hook: z.string().min(1),
  script: z.string().min(1),
  hashtags: z.array(z.string()).default([]),
  sourceRefs: z.array(z.string()).default([]),
  reasoning: z.string().max(200).optional(),
});

/** 同行信息整理输出 schema（marketing.competitor_notes，V2.1）：
 * 人工浏览公开内容粘贴→AI 提炼结构化要点；结果只进知识库草稿（人工审核生效，A09） */
export const CompetitorNotesOutputSchema = z.object({
  summary: z.string().min(1),
  points: z
    .array(
      z.object({
        kind: z.enum(['price', 'activity', 'selling_point', 'channel', 'other']),
        content: z.string().min(1),
      }),
    )
    .default([]),
  caution: z.string().nullable().default(null),
});

export type VideoCopyOutput = z.infer<typeof VideoCopyOutputSchema>;
export type CompetitorNotesOutput = z.infer<typeof CompetitorNotesOutputSchema>;

/** 灵感拆解输出 schema（marketing.inspiration_dissect，M02 批次B）：粘贴爆款原文→
 * 结构化拆解 + 一句「我们店能借鉴什么」。建议态预览，人工确认后才录入灵感库；
 * reasoning（T2 决策留痕）：可选 ≤200 字决策说明，落库供门店复盘 */
export const InspirationDissectOutputSchema = z.object({
  hookText: z.string().min(1),
  structure: z.string().min(1),
  rhythm: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  takeaway: z.string().min(1),
  reasoning: z.string().max(200).optional(),
});
export type InspirationDissectOutput = z.infer<typeof InspirationDissectOutputSchema>;

/** 灵感扫描输出 schema（marketing.inspiration_scan，M02 批次B）：联网搜近一周公开
 * 爆款分析→候选条目预览。不含 takeaway（借鉴点属人工确认后的拆解阶段），
 * 加 sourceUrl 供溯源；items 可空（搜不到如实说明，宁缺毋滥） */
export const InspirationScanOutputSchema = z.object({
  items: z
    .array(
      z.object({
        platform: z.string().min(1),
        title: z.string().min(1),
        hookText: z.string().min(1),
        structure: z.string().min(1),
        rhythm: z.string().nullable().default(null),
        metrics: z.string().nullable().default(null),
        tags: z.array(z.string()).default([]),
        sourceUrl: z.string().nullable().default(null),
      }),
    )
    .max(5)
    .default([]),
  scanNote: z.string().nullable().default(null),
});
export type InspirationScanOutput = z.infer<typeof InspirationScanOutputSchema>;

/** 短视频选题包输出 schema（marketing.video_topic，2026-09-04 短视频运营升级）：
 * 联网扫热点→按账号定位筛选→产出选题建议（3~5 个），纯建议态由人挑选；
 * reasoning（T2 决策留痕）：可选 ≤200 字决策说明，落库供门店复盘 */
export const VideoTopicOutputSchema = z.object({
  topics: z
    .array(
      z.object({
        title: z.string().min(1),
        angle: z.string().min(1),
        reason: z.string().min(1),
        hookDirection: z.string().min(1),
        structure: z.string().min(1),
        difficulty: z.enum(['低', '中', '高']),
        type: z.enum(['hot', 'evergreen']),
        source: z.string().nullable().default(null),
      }),
    )
    .min(1)
    .max(6),
  hotNote: z.string().nullable().default(null),
  reasoning: z.string().max(200).optional(),
});
export type VideoTopicOutput = z.infer<typeof VideoTopicOutputSchema>;

/** 注册表层宽松契约（2026-08-19）：该模型输出字段纪律不稳定（中文字段名/缺字段/纯文本），
 * 在 dispatch 层按严格 schema 校验会把本可归一的结果直接降级（实测约 1/3 失败）。
 * 分层校验：注册表只拦「非 JSON」的硬失败；字段级严格契约由 MarketingService
 * 在确定性规范化（normalizeVideoCopy/normalizeCompetitorNotes，S11）之后执行。 */
const LooseJsonOutput = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);

const VIDEO_COPY_CONSTRAINTS = {
  boundary:
    '仅依据提供的知识库素材与用户参数创作；不诋毁竞品、不用极限词（最好/第一/顶级等广告法禁用表述）、不承诺价格优惠质保工期；输出为草稿态供人工采用',
};

const GEO_AUDIT_CONSTRAINTS = {
  boundary:
    '仅基于本次联网搜索实际看到的结果作诊断，搜不到如实说未搜到；不承诺任何排名效果；不建议刷单刷评等违规手段；输出为建议态草稿供人工采用',
};

const COMPETITOR_NOTES_CONSTRAINTS = {
  boundary:
    '仅提炼用户粘贴文本中的事实要点，不推测、不补充外部信息、不评价好坏；输出为知识库草稿素材，需人工审核后生效',
};

const VIDEO_TOPIC_CONSTRAINTS = {
  boundary:
    '热点与行业动态仅依据联网搜索实际结果，搜不到就如实说明、不得编造热点；选题必须贴合账号定位与门店实际业务；输出为选题建议，由人挑选后才进入创作',
};

const INSPIRATION_DISSECT_CONSTRAINTS = {
  boundary:
    '仅拆解用户粘贴文本中实际存在的内容，不推测、不补充外部信息；提炼结构与方向而非照抄文案；输出为建议态预览，人工确认后才录入灵感库',
};

const INSPIRATION_SCAN_CONSTRAINTS = {
  boundary:
    '候选条目仅依据联网搜索实际看到的公开内容，搜不到如实说明、不得编造；来源链接与互动数据必须是搜索结果真实披露的；输出为候选预览，人工确认后逐条录入灵感库',
};

/** marketing 任务注册（V2.1 经营任务中心首批）：OnModuleInit 向全局注册表登记。
 * 2026-09-04 Task6：三任务型挂 postLint 输出验证（hard→failed 可重试，soft→warn 留痕），
 * 营销产出（对外文案/知识草稿）与销售聊天共用同一套行为红线（极限词/英文泄漏）。 */
@Injectable()
export class MarketingAiRegistrations implements OnModuleInit {
  constructor(private readonly registry: AiTaskRegistry) {}

  onModuleInit(): void {
    // skillVersion 与 SKILL.md frontmatter version 同步（V1.5 批次5 提交纪律）。
    // 2026-09-07 批次B Task2：两技能注入 inspirations 字段（版本 1→2，@v1 快照留回滚位）
    // 2026-09-02 M02 T2 决策留痕：三任务型输出契约加可选 reasoning（版本各 +1，旧版快照留档）
    this.registry.register({
      taskType: 'marketing.video_copy',
      skillName: 'skill-video-copy',
      outputSchema: LooseJsonOutput,
      // P3-F02：reasoning 落库边界限长（≤200 句边界截断，前端折叠展示直读 output）
      normalize: capLooseReasoning,
      deadlineSeconds: 120,
      // v4（2026-09-09 二轮复验 R2-06 归因）：硬边界补三条——参数效果不得因果错位
      // （防晒黑≠红外线阻隔，WHO 口径 UVA/UVB）、效果不打包票（晒不黑类保证禁止）、
      // reasoning 不得建议人工换回禁词绕过红线；经营历史类背景事实无素材不写。@v3 快照留档
      skillVersion: 4,
      constraints: VIDEO_COPY_CONSTRAINTS,
      postLint: lintVideoCopyOutput,
    });
    // 短视频选题工作流（2026-09-04 运营升级）：扫热点→定位筛选→选题包；
    // 联网搜索耗时较长，deadline 放宽到 180s
    this.registry.register({
      taskType: 'marketing.video_topic',
      skillName: 'skill-video-topic',
      outputSchema: LooseJsonOutput,
      // P3-F02：reasoning 落库边界限长（≤200 句边界截断，前端折叠展示直读 output）
      normalize: capLooseReasoning,
      deadlineSeconds: 180,
      skillVersion: 4,
      constraints: VIDEO_TOPIC_CONSTRAINTS,
      postLint: lintVideoTopicOutput,
    });
    // 灵感拆解（M02 批次B Task2）：粘贴爆款原文→结构化拆解建议，纯文本任务无联网需求
    this.registry.register({
      taskType: 'marketing.inspiration_dissect',
      skillName: 'skill-inspiration-dissect',
      outputSchema: LooseJsonOutput,
      // P3-F02：reasoning 落库边界限长（≤200 句边界截断，前端折叠展示直读 output）
      normalize: capLooseReasoning,
      deadlineSeconds: 120,
      // v3（2026-09-09 阶段三 R03/R04 归因）：证据分层方法论（原文直录/用户转述/评论区
      // 三层来源+缺失即缺失不连坐+观察归因分离），治「无互动数据→拒描述节奏」误判，@v2 快照留档
      skillVersion: 3,
      constraints: INSPIRATION_DISSECT_CONSTRAINTS,
      postLint: lintInspirationDissectOutput,
    });
    // 灵感周期扫描（M02 批次B Task2，手动版）：联网搜公开爆款分析→候选预览（不入库）。
    // 极限词维持不拦：拆解对象是同行内容，极限词常是被分析的原话（如「全网最低」猫腻
    // 揭秘），机械拦截误伤率高——预览不直接入库，人工确认时把关。
    // RF-03（2026-09-09）：挂 R1-only 英文泄漏检——{text:"I can't use read…"} 过程说明
    // 曾落 done 且接口 200 空 items 假成功；英文过程 hard 拦成 failed（autoRetry 知因再答）
    this.registry.register({
      taskType: 'marketing.inspiration_scan',
      skillName: 'skill-inspiration-scan',
      outputSchema: LooseJsonOutput,
      // P3-F02：reasoning 落库边界限长（≤200 句边界截断，前端折叠展示直读 output）
      normalize: capLooseReasoning,
      deadlineSeconds: 180,
      skillVersion: 1,
      constraints: INSPIRATION_SCAN_CONSTRAINTS,
      postLint: lintInspirationScanOutput,
    });
    this.registry.register({
      taskType: 'marketing.competitor_notes',
      skillName: 'skill-competitor-notes',
      outputSchema: LooseJsonOutput,
      // P3-F02：reasoning 落库边界限长（≤200 句边界截断，前端折叠展示直读 output）
      normalize: capLooseReasoning,
      deadlineSeconds: 120,
      constraints: COMPETITOR_NOTES_CONSTRAINTS,
      postLint: lintCompetitorNotesOutput,
    });
    // GEO 优化助手（V1.5 批次4）：一键诊断门店可被搜索到程度——联网搜索+建议态草稿，不承诺排名
    this.registry.register({
      taskType: 'marketing.geo_audit',
      skillName: 'skill-geo-audit',
      outputSchema: LooseJsonOutput,
      // P3-F02：reasoning 落库边界限长（≤200 句边界截断，前端折叠展示直读 output）
      normalize: capLooseReasoning,
      deadlineSeconds: 120,
      constraints: GEO_AUDIT_CONSTRAINTS,
      // RF-03（2026-09-09）：英文过程说明曾 201/done 假可用——R1-only 泄漏检收口
      postLint: lintGeoAuditOutput,
    });
  }
}

/** reasoning 落库限长（P3-F02 修复，2026-09-08 phase3 评测实锤：205 字 reasoning 原样
 * 落库）：LooseJsonOutput 宽松契约下 ai_tasks.output 存的是模型原始对象，前端折叠展示
 * 直读该字段——读侧 reasoningField 的 200 字截断管不到落库形态。注册表 normalize 钩子
 * 在落库边界就地限长（与读侧同一 truncateAtSentence 判据：句边界截断不产残句），
 * 顶层与 draft/topics/dissect 包装层、中文键「决策说明」全覆盖（pickReasoning 同口径）。 */
function capLooseReasoning(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const src = raw as Record<string, unknown>;
  const cap = (obj: Record<string, unknown>): void => {
    for (const key of ['reasoning', '决策说明']) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim() && v.length > 200) {
        obj[key] = truncateAtSentence(v.trim(), 200);
      }
    }
  };
  cap(src);
  const wrap = src.draft ?? src.topics ?? src.dissect;
  if (wrap && typeof wrap === 'object' && !Array.isArray(wrap)) {
    cap(wrap as Record<string, unknown>);
  }
  return src;
}

/** postLint 字段提取（2026-09-04 Task6）：注册表层是宽松契约（LooseJsonOutput=
 * 纯文本或任意对象），marketing 的严格归一（normalizeVideoCopy 等）在 MarketingService
 * 读结果时才执行，所以这里自带轻量提取——只取各任务输出契约的文本字段（中英文键别名
 * 与归一器同口径），字段缺失不检（结构问题归 schema/归一器，lint 只管行为红线：
 * 极限词 hard / 英文泄漏 hard / markdown soft）。纯文本输出整体作为正文送检
 * （此时模型把全部内容写成了文本）。 */
function pickStr(output: unknown, keys: string[]): string | undefined {
  if (typeof output === 'string') {
    const t = output.trim();
    return t || undefined;
  }
  if (!output || typeof output !== 'object') return undefined;
  const src = output as Record<string, unknown>;
  // draft 包装层解包（与 normalizeVideoCopy 同口径）
  const inner =
    src.draft && typeof src.draft === 'object' ? (src.draft as Record<string, unknown>) : src;
  for (const k of keys) {
    const v = inner[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/** 根 text 字段送检（2026-09-07 批次B冒烟盲区修复）：模型偶发把英文思维链整段
 * 写进 {text: "..."} 而非任何契约字段——linter 只检契约字段时空字段集=放行，
 * 英文泄漏直通到 safeParse 才以「契约不符」500 收场（用户看到重试而非可诊断的
 * lint 拦截）。正常输出无根 text，此检零成本；思维链输出由 R1 密度判据 hard 拦。 */
function rootText(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const t = (output as Record<string, unknown>).text;
  return typeof t === 'string' && t.trim() ? t : undefined;
}

/** 决策留痕提取（T2）：reasoning 在 draft/topics/dissect 包装层内或顶层均可能
 * （与三个归一器的解包同口径），中文键「决策说明」兼容——linter 与归一器共用
 * 同一提取逻辑，送检口径=落库口径 */
function pickReasoning(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const src = output as Record<string, unknown>;
  const wrap = src.draft ?? src.topics ?? src.dissect;
  const inner =
    wrap && typeof wrap === 'object' && !Array.isArray(wrap)
      ? (wrap as Record<string, unknown>)
      : src;
  const v = inner.reasoning ?? inner['决策说明'] ?? src.reasoning ?? src['决策说明'];
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** video_copy：reply 类字段为 title/hook/script（hashtag/来源引用多为型号短语，
 * 密度判据会误伤，不检）；纯文本输出视为完整口播文案只检 script；
 * reasoning（T2 决策留痕）一并送检——决策说明是落库文本，中文密度/极限词同口径 */
function lintVideoCopyOutput(output: unknown): LintResult {
  const fields: Record<string, string> = {};
  if (typeof output === 'string') {
    if (output.trim()) fields.script = output;
  } else {
    const title = pickStr(output, ['title', '标题']);
    const hook = pickStr(output, ['hook', '钩子']);
    const script = pickStr(output, ['script', '文案', '口播文案']);
    if (title) fields.title = title;
    if (hook) fields.hook = hook;
    if (script) fields.script = script;
    const rs = pickReasoning(output);
    if (rs) fields.reasoning = rs;
    const rt = rootText(output);
    if (rt) fields.rootText = rt;
  }
  return lintAgentOutput(fields);
}

/** video_topic：各 topic 的五个文本字段逐项检（字段名带 topics[i] 前缀，违规可定位）。
 * 选择逐项而非拼检：拼接会把单个 topic 的英文泄漏稀释成整体低密度而漏检。
 * source（可能是英文链接/标题）与 hotNote（搜索过程说明）不检——非对外文案；
 * reasoning（T2 决策留痕）一并送检，中文密度/极限词同口径 */
function lintVideoTopicOutput(output: unknown): LintResult {
  const fields: Record<string, string> = {};
  if (typeof output === 'string') {
    if (output.trim()) fields.topics = output;
    return lintAgentOutput(fields);
  }
  // topics 数组解析与 normalizeVideoTopics 同口径：包装层 + 中英文键
  const src = (output ?? {}) as Record<string, unknown>;
  const inner =
    src.topics && typeof src.topics === 'object' && !Array.isArray(src.topics)
      ? (src.topics as Record<string, unknown>)
      : src;
  const rawTopics = Array.isArray(inner.topics) ? inner.topics : (inner['选题'] ?? src.topics);
  const rtTopic = rootText(output);
  if (rtTopic) fields.rootText = rtTopic;
  const rsTopic = pickReasoning(output);
  if (rsTopic) fields.reasoning = rsTopic;
  if (!Array.isArray(rawTopics)) return lintAgentOutput(fields);
  rawTopics.forEach((t, i) => {
    if (!t || typeof t !== 'object') return;
    const spec: Array<[string, string[]]> = [
      ['title', ['title', '选题', '标题']],
      ['angle', ['angle', '切入角度', '角度']],
      ['reason', ['reason', '选题理由', '理由']],
      ['hookDirection', ['hookDirection', '钩子方向', '钩子']],
      ['structure', ['structure', '参考结构', '结构']],
    ];
    for (const [name, keys] of spec) {
      const v = pickStr(t, keys);
      if (v) fields[`topics[${i}].${name}`] = v;
    }
  });
  return lintAgentOutput(fields);
}

/** inspiration_dissect：四文本字段逐项检（takeaway 也是落库文本一并检）；
 * tags 是短词标签，密度判据会误伤，不检（与 video_copy 的 hashtags 同口径）；
 * 纯文本输出整体作为拆解正文送检；reasoning（T2 决策留痕）一并送检同口径 */
function lintInspirationDissectOutput(output: unknown): LintResult {
  const fields: Record<string, string> = {};
  if (typeof output === 'string') {
    if (output.trim()) fields.hookText = output;
  } else {
    const hookText = pickStr(output, ['hookText', '钩子文案', '钩子']);
    const structure = pickStr(output, ['structure', '结构']);
    const rhythm = pickStr(output, ['rhythm', '节奏']);
    const takeaway = pickStr(output, ['takeaway', '借鉴点', '我们店能借鉴什么']);
    if (hookText) fields.hookText = hookText;
    if (structure) fields.structure = structure;
    if (rhythm) fields.rhythm = rhythm;
    if (takeaway) fields.takeaway = takeaway;
    const rs = pickReasoning(output);
    if (rs) fields.reasoning = rs;
    const rt = rootText(output);
    if (rt) fields.rootText = rt;
  }
  return lintAgentOutput(fields);
}

/** 英文过程泄漏专检（RF-03 修复，2026-09-09 fixbatch 复验实锤：扫描 {text:"I can't
 * use read…"} 落 done、接口 200 空 items 假成功；GEO 同形态 201/done）：只跑 R1 判据
 * （cjk-density，与 output-lint 同源薄函数），不拦极限词——扫描/诊断对象常含被分析的
 * 原话与搜索引文，机械拦截误伤高（inspiration_scan 不挂 R3 的既有裁定不变）。
 * 长文本（≥20 字）逐条过密度判据；短标签/枚举与 URL/链接不检（英文型号、来源链接
 * 合法存在）。rootText 兜底 {text:思维链} 形态（批次B 冒烟盲区同款）。 */
function lintEnglishLeakOnly(labeled: Array<[string, string | undefined | null]>): LintResult {
  const issues: LintIssue[] = [];
  for (const [field, value] of labeled) {
    if (typeof value !== 'string') continue;
    const t = value.trim();
    if (t.length < 20) continue;
    // R2-02 修复（2026-09-09 二轮复验实锤）：旧口径 includes('://') 整段跳过——英文
    // 过程文本追加任意 URL 即绕过（不消耗模型可复现）。改为剔除 URL 后再判：剔除后
    // 不足 20 字 = 纯链接/短标签字段，跳过；否则对剩余正文跑同一密度判据。
    const prose = t.replace(/\S*:\/\/\S*/g, ' ').trim();
    if (prose.length < 20) continue;
    if (!hasCjkText(prose) || exceedsAsciiDensity(prose)) {
      issues.push({
        rule: 'cjk-density',
        severity: 'hard',
        field,
        message: '输出非简体中文（疑似思维链/过程泄漏）',
      });
    }
  }
  return { pass: !issues.some((i) => i.severity === 'hard'), issues };
}

/** inspiration_scan：rootText + scanNote + items 的 prose 字段（title/hookText/
 * structure/rhythm/metrics）过英文泄漏检；platform/tags/sourceUrl 不检（短标签/链接）。 */
function lintInspirationScanOutput(output: unknown): LintResult {
  const labeled: Array<[string, string | undefined | null]> = [['rootText', rootText(output)]];
  if (output && typeof output === 'object') {
    const src = output as Record<string, unknown>;
    const note = src.scanNote ?? src['扫描说明'];
    labeled.push(['scanNote', typeof note === 'string' ? note : undefined]);
    const rawItems = src.items ?? src['候选'] ?? src['候选灵感'] ?? src.inspirations;
    if (Array.isArray(rawItems)) {
      rawItems.forEach((it, i) => {
        if (!it || typeof it !== 'object') return;
        const o = it as Record<string, unknown>;
        for (const [name, keys] of [
          ['title', ['title', '标题']],
          ['hookText', ['hookText', '钩子文案', '钩子']],
          ['structure', ['structure', '结构']],
          ['rhythm', ['rhythm', '节奏']],
          ['metrics', ['metrics', '互动数据', '数据']],
        ] as Array<[string, string[]]>) {
          const v = pickStr(o, keys);
          labeled.push([`items[${i}].${name}`, v]);
        }
      });
    }
  }
  return lintEnglishLeakOnly(labeled);
}

/** geo_audit：rootText + verdict/draft 与 findings[].detail/dimension、suggestions[]
 * 过英文泄漏检（技能契约字段面）；seen 布尔与短枚举天然不检。 */
function lintGeoAuditOutput(output: unknown): LintResult {
  const labeled: Array<[string, string | undefined | null]> = [['rootText', rootText(output)]];
  if (output && typeof output === 'object') {
    const src = output as Record<string, unknown>;
    for (const k of ['verdict', 'draft'] as const) {
      const v = src[k];
      labeled.push([k, typeof v === 'string' ? v : undefined]);
    }
    if (Array.isArray(src.suggestions)) {
      src.suggestions.forEach((s, i) =>
        labeled.push([`suggestions[${i}]`, typeof s === 'string' ? s : undefined]),
      );
    }
    if (Array.isArray(src.findings)) {
      src.findings.forEach((f, i) => {
        if (!f || typeof f !== 'object') return;
        const o = f as Record<string, unknown>;
        labeled.push([
          `findings[${i}].dimension`,
          typeof o.dimension === 'string' ? o.dimension : undefined,
        ]);
        labeled.push([
          `findings[${i}].detail`,
          typeof o.detail === 'string' ? o.detail : undefined,
        ]);
      });
    }
  }
  return lintEnglishLeakOnly(labeled);
}

/** competitor_notes：summary+points 内容（caution 同为落库文本一并检）；
 * points 支持字符串项与 {content|内容} 对象项（归一器同口径），kind 是枚举不检 */
function lintCompetitorNotesOutput(output: unknown): LintResult {
  const fields: Record<string, string> = {};
  if (typeof output === 'string') {
    if (output.trim()) fields.summary = output;
    return lintAgentOutput(fields);
  }
  const src = (output ?? {}) as Record<string, unknown>;
  const summary = pickStr(src, ['summary', '摘要']);
  if (summary) fields.summary = summary;
  const caution = pickStr(src, ['caution', '注意']);
  if (caution) fields.caution = caution;
  const points = src.points ?? src['要点'];
  if (Array.isArray(points)) {
    points.forEach((p, i) => {
      const content =
        typeof p === 'string' ? p.trim() || undefined : pickStr(p, ['content', '内容']);
      if (content) fields[`points[${i}]`] = content;
    });
  }
  const rt = rootText(output);
  if (rt) fields.rootText = rt;
  return lintAgentOutput(fields);
}

@Module({
  imports: [AiDispatchModule],
  providers: [MarketingAiRegistrations],
})
export class MarketingAiModule {}
