import { Injectable, Logger } from '@nestjs/common';
import type { AiTask } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { JwtPayload } from '../auth/auth.types';
import { AiDispatchService } from '../ai-dispatch/ai-dispatch.service';
import { AuditService } from '../../common/audit';
import { KNOWLEDGE_KIND } from '../knowledge/knowledge.constants';
import { KnowledgeService } from '../knowledge/knowledge.service';
import type {
  CompetitorNotesOutput,
  InspirationDissectOutput,
  InspirationScanOutput,
  VideoCopyOutput,
  VideoTopicOutput,
} from './marketing-ai.module';
import {
  VideoCopyOutputSchema,
  CompetitorNotesOutputSchema,
  InspirationDissectOutputSchema,
  InspirationScanOutputSchema,
  VideoTopicOutputSchema,
} from './marketing-ai.module';
import { VideoInspirationService } from './video-inspiration.service';
import { truncateAtSentence } from '../ai-dispatch/output-normalize.util';

/** 账号定位结构（短视频运营升级 2026-09-04）：账号的"身份证"，
 * 选题筛选与脚本生成均注入；定位是配置而非写死提示词——换客户店改配置即可迁移 */
export interface VideoPositioning {
  storePositioning: string;
  targetAudience: string;
  persona: string;
  pillars: string[];
  resources: string;
  tone: string;
}

const POSITIONING_KEY = 'marketing.video.positioning';

/** 作品集使用虚构定位；使用者可在账号定位卡编辑后覆盖。 */
export const DEFAULT_VIDEO_POSITIONING: VideoPositioning = {
  storePositioning: '虚构汽车服务演示项目，展示服务流程与协作能力，不代表实际商家',
  targetAudience: '演示受众：希望了解服务流程的用户；实际受众由使用者另行配置',
  persona: '演示讲解员：介绍流程与注意事项；实际出镜人员及授权由使用者配置',
  pillars: [
    '产品科普（膜的种类/真假鉴别/参数怎么读）',
    '施工过程（标准化流程/细节特写/工期透明）',
    '客户案例（提车/完工前后对比/客户反馈）',
    '行业揭秘避坑（贴膜内幕/低价猫腻/选购指南）',
    '热点借势（车市新闻/本地事件/季节话题）',
  ],
  resources: '仅使用自行制作并已获授权的虚构演示素材，实际资源由使用者配置',
  tone: '清楚、客观、简洁，不编造产品参数或经营事实',
};

/** 经营任务中心（V2.1 首批）：短视频文案草稿 + 同行信息整理。
 * 人机边界：AI 输出一律草稿/建议态——文案由人采用后自行发布（已复制≠已发送，A10）；
 * 同行整理结果只进知识库草稿（kind=competitor），人工审核生效（A05/A09）。
 * 2026-09-04 短视频运营升级：文案生成器 → 运营工作流（账号定位 → 选题包 → 脚本）。
 * 2026-09-07 批次B灵感库闭环：选题/脚本注入爆款参考（可选增强，空数组照常），
 * 灵感拆解与周期扫描均建议态预览——由人确认后才录入灵感库。
 * P3-F01 修复（2026-09-08 phase3 评测实锤）：五个生成路由统一走 submitTaskAutoRetry——
 * 此前仍是 submitTask，lint 拦截（极限词误杀/模型偶发违规）直接 409 抛给用户，
 * ebfd89d 的「拦截→带 lintFeedback 自动重派」在营销路由形同虚设（选题 3 轮全 failed）。 */
@Injectable()
export class MarketingService {
  private readonly logger = new Logger(MarketingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiDispatchService,
    private readonly knowledge: KnowledgeService,
    private readonly audit: AuditService,
    private readonly inspirations: VideoInspirationService,
  ) {}

  /** 账号定位读取：未保存过时返回默认草稿（不落库，首次保存才写） */
  async getVideoPositioning(): Promise<VideoPositioning> {
    const row = await this.prisma.systemMeta.findUnique({ where: { key: POSITIONING_KEY } });
    if (!row)
      return { ...DEFAULT_VIDEO_POSITIONING, pillars: [...DEFAULT_VIDEO_POSITIONING.pillars] };
    try {
      const parsed = JSON.parse(row.value) as VideoPositioning;
      if (
        typeof parsed.storePositioning === 'string' &&
        typeof parsed.targetAudience === 'string' &&
        typeof parsed.persona === 'string' &&
        Array.isArray(parsed.pillars)
      ) {
        return {
          storePositioning: parsed.storePositioning,
          targetAudience: parsed.targetAudience,
          persona: parsed.persona,
          pillars: parsed.pillars.map(String),
          resources: typeof parsed.resources === 'string' ? parsed.resources : '',
          tone: typeof parsed.tone === 'string' ? parsed.tone : '',
        };
      }
    } catch {
      // 值损坏时回退默认草稿（不覆盖，等下次保存修复）
    }
    return { ...DEFAULT_VIDEO_POSITIONING, pillars: [...DEFAULT_VIDEO_POSITIONING.pillars] };
  }

  /** 账号定位保存（m02:edit，controller 层校验）：覆盖 SystemMeta + 审计留痕 */
  async saveVideoPositioning(actor: JwtPayload, dto: VideoPositioning): Promise<VideoPositioning> {
    const before = await this.getVideoPositioning();
    await this.prisma.systemMeta.upsert({
      where: { key: POSITIONING_KEY },
      create: { key: POSITIONING_KEY, value: JSON.stringify(dto) },
      update: { value: JSON.stringify(dto) },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'marketing.video.positioning_saved',
      objectType: 'system_meta',
      objectId: POSITIONING_KEY,
      before: { positioning: before },
      after: { positioning: dto },
    });
    return dto;
  }

  /** done 但契约不符的兜底（P3-F02 修复，2026-09-08 phase3 评测实锤：文案 3 条任务
   * done 而主接口仅 1 次成功）——注册表宽松契约（LooseJsonOutput）落库成功不等于读侧
   * 严格归一（normalizeVideoCopy 等 + 严格 schema）能通过；直接 409 会让任务表显示
   * 「成功」而用户白等一轮。兜底：带 contractFeedback 重发一次（与 lint 反馈重试同款
   * 「知因再答」机制），仍不符才 409。单端点最多 3 次 AI 调用（autoRetry 2 + 契约重发 1），
   * 均为用户主动触发的生成入口，成本可控。label 保持各端点既有 409 文案不变。 */
  private async submitWithContractRetry<T>(
    taskType: string,
    context: Record<string, unknown>,
    ref: { type: string; id: string },
    label: string,
    validate: (output: unknown) => { success: true; data: T } | { success: false; error: unknown },
  ): Promise<{ task: AiTask; data: T }> {
    const issuesOf = (error: unknown): string =>
      JSON.stringify((error as { issues?: unknown[] })?.issues?.slice(0, 3) ?? error).slice(0, 300);
    let task = await this.ai.submitTaskAutoRetry(taskType, context, ref);
    let result = validate(task.output);
    if (!result.success && task.status === 'done') {
      this.logger.warn(
        `${taskType} 任务 ${task.id} done 但契约不符：${issuesOf(result.error)}——带 contractFeedback 重发`,
      );
      task = await this.ai.submitTask(
        taskType,
        {
          ...context,
          contractFeedback: `上一轮输出不符合输出契约（${issuesOf(result.error)}）。请严格按技能输出契约重新输出完整 JSON，必填字段一个不能少，不要输出契约之外的包装层。`,
        },
        ref,
      );
      result = validate(task.output);
    }
    if (!result.success) {
      this.logger.warn(`${taskType} 输出校验失败：${issuesOf(result.error)}`);
      throw new AppException(ErrorCode.AI_TASK_INVALID_STATE, `${label}不符合契约，请重试`);
    }
    return { task, data: result.data };
  }

  /** 选题包生成（手动触发，m02:edit）：定位注入 → 联网扫热点 → 定位筛选 → 选题建议。
   * 当日结果存 SystemMeta 供复看；重跑覆盖（手动按钮语义 = 刷新今天的选题）。 */
  async generateVideoTopics(actor: JwtPayload): Promise<{
    taskId: string;
    dateKey: string;
    topics: VideoTopicOutput;
  }> {
    const positioning = await this.getVideoPositioning();
    // 灵感注入（批次B Task 2，可选增强）：按内容支柱检索 ≤3 条爆款参考进提示词——
    // 选题可参考其钩子方向与结构组织（不照抄文案）；灵感库为空/无命中时是空数组，
    // 选题生成照常（不因缺参考而失败）
    const inspirations = await this.inspirations.searchForContext(
      positioning.pillars,
      undefined,
      3,
    );
    const dateKey = todayKey();
    const { task, data } = await this.submitWithContractRetry(
      'marketing.video_topic',
      {
        date: dateKey,
        positioning: {
          store: positioning.storePositioning,
          audience: positioning.targetAudience,
          persona: positioning.persona,
          pillars: positioning.pillars,
          resources: positioning.resources,
          tone: positioning.tone,
        },
        inspirations,
        instruction:
          '按技能流程：先联网搜索近 1-2 天热点与汽车/贴膜行业动态，再按账号定位筛选相关可借势的热点；结合内容支柱补充常青选题；输出 3~5 个选题建议。',
      },
      { type: 'marketing', id: actor.sub },
      '选题生成结果',
      (out) => VideoTopicOutputSchema.safeParse(normalizeVideoTopics(out)),
    );
    const payload: StoredTopics = {
      taskId: task.id,
      generatedAt: new Date().toISOString(),
      data,
    };
    await this.prisma.systemMeta.upsert({
      where: { key: topicsKey(dateKey) },
      create: { key: topicsKey(dateKey), value: JSON.stringify(payload) },
      update: { value: JSON.stringify(payload) },
    });
    return { taskId: task.id, dateKey, topics: data };
  }

  /** 当日选题包复看：未生成过返回 null（前端引导去点生成按钮） */
  async getVideoTopics(
    date = new Date(),
  ): Promise<{ taskId: string; topics: VideoTopicOutput } | null> {
    const row = await this.prisma.systemMeta.findUnique({
      where: { key: topicsKey(todayKey(date)) },
    });
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as StoredTopics;
      const out = VideoTopicOutputSchema.safeParse(parsed.data);
      if (out.success) return { taskId: parsed.taskId, topics: out.data };
    } catch {
      // 损坏视为未生成
    }
    return null;
  }

  /** 短视频文案草稿：知识库素材（产品/品牌/案例）+ 用户参数 → AI 创作。
   * 2026-09-04 升级：注入账号定位 + 可选选题上下文（从选题包带入时按其钩子方向/结构创作） */
  async videoCopy(
    actor: JwtPayload,
    dto: {
      topic: string;
      productModel?: string;
      carModel?: string;
      style?: string;
      durationSec?: number;
      topicContext?: {
        angle?: string;
        reason?: string;
        hookDirection?: string;
        structure?: string;
        type?: 'hot' | 'evergreen';
        source?: string;
      };
    },
  ): Promise<{ taskId: string; draft: VideoCopyOutput }> {
    const materials = await this.prisma.knowledgeItem.findMany({
      where: {
        status: 'active',
        licensed: true,
        kind: { in: ['product', 'brand', 'case'] },
        ...(dto.productModel
          ? {
              OR: [
                { title: { contains: dto.productModel, mode: 'insensitive' } },
                { content: { contains: dto.productModel, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: { title: true, content: true, source: true },
      take: 5,
    });
    const positioning = await this.getVideoPositioning();
    // 灵感注入（批次B Task 2，可选增强）：以选题关键词（选题包的切入角度优先，
    // 否则取主题前 8 字）检索 ≤2 条爆款参考；空数组照常创作
    const keywordHint = dto.topicContext?.angle?.trim() || dto.topic.slice(0, 8);
    const inspirations = await this.inspirations.searchForContext(
      positioning.pillars,
      keywordHint,
      2,
    );

    const { task, data } = await this.submitWithContractRetry(
      'marketing.video_copy',
      {
        topic: dto.topic,
        productModel: dto.productModel ?? null,
        carModel: dto.carModel ?? null,
        style: dto.style ?? '专业可信',
        durationSec: dto.durationSec ?? 30,
        positioning: {
          store: positioning.storePositioning,
          audience: positioning.targetAudience,
          persona: positioning.persona,
          tone: positioning.tone,
        },
        inspirations,
        topicContext: dto.topicContext
          ? {
              angle: dto.topicContext.angle ?? null,
              reason: dto.topicContext.reason ?? null,
              hookDirection: dto.topicContext.hookDirection ?? null,
              structure: dto.topicContext.structure ?? null,
              type: dto.topicContext.type ?? null,
              source: dto.topicContext.source ?? null,
            }
          : null,
        materials: materials.map((m) => ({
          title: m.title,
          content: m.content.slice(0, 400),
          source: m.source,
        })),
      },
      { type: 'marketing', id: actor.sub },
      '文案生成结果',
      (out) => VideoCopyOutputSchema.safeParse(normalizeVideoCopy(out)),
    );
    return { taskId: task.id, draft: data };
  }

  /** 灵感拆解（批次B Task 2）：粘贴爆款原文 → AI 结构化拆解（钩子/结构/节奏/标签 +
   * 一句「我们店能借鉴什么」）。建议态预览——结果不落库，人工确认（可改）后走
   * 灵感库创建端点录入（拆解结果=建议不是事实，人工把关）。 */
  async dissectInspiration(
    actor: JwtPayload,
    dto: { rawText: string; platform?: string; isPeer?: boolean },
  ): Promise<{ taskId: string; dissect: InspirationDissectOutput }> {
    const { task, data } = await this.submitWithContractRetry(
      'marketing.inspiration_dissect',
      {
        rawText: dto.rawText,
        platform: dto.platform ?? null,
        isPeer: dto.isPeer ?? false,
      },
      { type: 'marketing', id: actor.sub },
      '拆解结果',
      (out) => InspirationDissectOutputSchema.safeParse(normalizeInspirationDissect(out)),
    );
    return { taskId: task.id, dissect: data };
  }

  /** 灵感周期扫描（手动版，批次B Task 2；T4 自动版经 InspirationScanScheduler 复用）：
   * 联网搜近一周「贴膜/汽车后市场」爆款公开分析 → 候选条目。手动路径只返回不入库
   * （候选是否成立由人判断），前端确认后逐条走创建端点录入；自动路径落 candidate。
   * 任务终态非 done（降级/熔断，2026-09 T4 补口径——原先静默返回空 items 会把
   * 「AI 失败」伪装成「没扫到」，自动版据此当日不再重试）→ 抛 409 引导重试；
   * done 且空 items = 本次无值得候选（宁缺毋滥不硬造）。 */
  async scanInspirations(actor: JwtPayload): Promise<{
    taskId: string;
    items: InspirationScanOutput['items'];
    scanNote: string | null;
  }> {
    const task = await this.ai.submitTaskAutoRetry(
      'marketing.inspiration_scan',
      {
        date: todayKey(),
        instruction:
          '按技能流程：联网搜索近一周「贴膜/汽车后市场」爆款视频与热门内容的公开分析文章，提炼 3~5 条候选灵感（含来源链接）。',
      },
      { type: 'marketing', id: actor.sub },
    );
    if (task.status !== 'done' || !task.output) {
      this.logger.warn(`inspiration_scan 任务未成功（status=${task.status}）`);
      throw new AppException(ErrorCode.AI_TASK_INVALID_STATE, '扫描任务未成功，请稍后重试');
    }
    const parsed = InspirationScanOutputSchema.safeParse(normalizeInspirationScan(task.output));
    if (!parsed.success) {
      this.logger.warn(
        `inspiration_scan 输出校验失败：${JSON.stringify(parsed.error.issues.slice(0, 3))}`,
      );
      throw new AppException(ErrorCode.AI_TASK_INVALID_STATE, '扫描结果不符合契约，请重试');
    }
    return { taskId: task.id, items: parsed.data.items, scanNote: parsed.data.scanNote };
  }

  /** 同行信息整理：人工浏览公开内容粘贴 → AI 提炼要点 → 知识库草稿（人工审核生效） */
  async competitorNotes(
    actor: JwtPayload,
    dto: { sourceText: string; sourcePlatform?: string },
  ): Promise<{ taskId: string; notes: CompetitorNotesOutput; knowledgeItemId: string }> {
    const { task, data } = await this.submitWithContractRetry(
      'marketing.competitor_notes',
      {
        sourceText: dto.sourceText,
        sourcePlatform: dto.sourcePlatform ?? '未注明',
      },
      { type: 'marketing', id: actor.sub },
      '整理结果',
      (out) => CompetitorNotesOutputSchema.safeParse(normalizeCompetitorNotes(out)),
    );

    const kindLabel: Record<string, string> = {
      price: '价格',
      activity: '活动',
      selling_point: '卖点',
      channel: '渠道',
      other: '其他',
    };
    const content = [
      `【AI 提炼摘要】${data.summary}`,
      ...(data.points.length > 0
        ? ['', ...data.points.map((p) => `· [${kindLabel[p.kind] ?? p.kind}] ${p.content}`)]
        : []),
      data.caution ? `\n【注意】${data.caution}` : '',
      '',
      '【原文摘录（人工浏览公开内容）】',
      dto.sourceText.slice(0, 2000),
    ]
      .filter((l) => l !== '')
      .join('\n');

    const item = await this.knowledge.create(actor, {
      kind: KNOWLEDGE_KIND.COMPETITOR,
      key: `competitor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: `同行信息整理（${dto.sourcePlatform ?? '未注明平台'} · ${new Date().toLocaleDateString('zh-CN')}）`,
      content,
      source: `人工浏览公开内容：${dto.sourcePlatform ?? '未注明'}（AI 提炼，待人工核实）`,
      licensed: false,
    });
    return { taskId: task.id, notes: data, knowledgeItemId: item.id };
  }
}

/** 当日选题包的 SystemMeta 存储payload（generateVideoTopics 写入，getVideoTopics 读出） */
interface StoredTopics {
  taskId: string;
  generatedAt: string;
  data: unknown;
}

/** 决策留痕透传（T2）：reasoning 从包装层内/顶层与中文键「决策说明」提取（与
 * pickReasoning 送检口径同源），截 200 字（schema 上限；超长截断救成 done 而非
 * 契约失败），无则返回空对象不硬造键。
 * P3-F02：改按句边界截断（与落库侧 capLooseReasoning、agent 侧 sanitizeReasoning
 * 同一 truncateAtSentence 判据），不再产「以门店」式残句 */
function reasoningField(
  inner: Record<string, unknown>,
  src: Record<string, unknown>,
): { reasoning?: string } {
  const v = inner.reasoning ?? inner['决策说明'] ?? src.reasoning ?? src['决策说明'];
  return typeof v === 'string' && v.trim() ? { reasoning: truncateAtSentence(v.trim(), 200) } : {};
}

function todayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function topicsKey(dateKey: string): string {
  return `marketing.video.topics.${dateKey}`;
}

/** 输出规范化（S11 确定性代码，2026-08-19）：该模型对字段名/类型纪律不稳定
 * （P6-02 基线同源问题）——中文字段名、字符串化数组、嵌套包装、纯文本输出
 * 统一归一后再过 schema；纯文本视为完整文案。 */
export function normalizeVideoCopy(raw: unknown): unknown {
  if (typeof raw === 'string' && raw.trim()) {
    const script = raw.trim();
    // R2-04（2026-09-09 二轮复验实锤）：title/hook 不再回灌用户输入——topic 可能携带
    // 指令文本（"附reasoning决策依据…约180至220字"曾被直接显示为标题/钩子，HTTP 200
    // 假可用）。纯文本形态以成稿自身首行做占位（≤30 字；文案草稿本就要人工采用改编，
    // 占位不编造事实、不泄漏指令）。
    const firstLine =
      script
        .split('\n')
        .find((l) => l.trim())
        ?.trim() ?? '';
    const stub = firstLine.slice(0, 30);
    return { title: stub, hook: stub, script, hashtags: [], sourceRefs: [] };
  }
  const src = (raw ?? {}) as Record<string, unknown>;
  const inner =
    src.draft && typeof src.draft === 'object' ? (src.draft as Record<string, unknown>) : src;
  const str = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = inner[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };
  const arr = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => String(x).trim())
      : typeof v === 'string' && v.trim()
        ? v.split(/[\s,，;；]+/).filter(Boolean)
        : [];
  // R2-04：缺 title 不再用 topic 兜底——置空让严格 schema 拒绝，走 contractFeedback
  // 重发要求模型补全业务字段（仍缺则 409），指令文本永远进不了成稿
  const title = str('title', '标题') ?? '';
  return {
    title,
    hook: str('hook', '钩子') ?? title,
    // P3-F02：{text/message/content/answer:…} 漂移形态按兜底键救回 script（与 agent 侧
    // normalizeSalesAgentOutput 同口径）——此前该形态 done 落库、读侧 script 空串 409
    script: str('script', '文案', '口播文案', 'text', 'message', 'content', 'answer') ?? '',
    hashtags: arr(inner.hashtags ?? inner['话题标签']),
    sourceRefs: arr(inner.sourceRefs ?? inner['素材来源']),
    ...reasoningField(inner, src),
  };
}

export function normalizeCompetitorNotes(raw: unknown): unknown {
  if (typeof raw === 'string' && raw.trim()) {
    return { summary: raw.trim().slice(0, 120), points: [], caution: null };
  }
  const src = (raw ?? {}) as Record<string, unknown>;
  const rawPoints = src.points ?? src['要点'];
  const kindMap: Record<string, string> = {
    价格: 'price',
    活动: 'activity',
    卖点: 'selling_point',
    渠道: 'channel',
    其他: 'other',
  };
  const points = Array.isArray(rawPoints)
    ? rawPoints
        .map((p): { kind: string; content: string } | null => {
          if (typeof p === 'string' && p.trim()) return { kind: 'other', content: p.trim() };
          if (p && typeof p === 'object') {
            const o = p as Record<string, unknown>;
            const content =
              typeof o.content === 'string'
                ? o.content
                : typeof o['内容'] === 'string'
                  ? o['内容']
                  : '';
            if (!content.trim()) return null;
            const kindRaw =
              typeof o.kind === 'string'
                ? o.kind
                : typeof o['类型'] === 'string'
                  ? o['类型']
                  : 'other';
            return {
              kind:
                kindMap[kindRaw] ??
                (['price', 'activity', 'selling_point', 'channel', 'other'].includes(kindRaw)
                  ? kindRaw
                  : 'other'),
              content: content.trim(),
            };
          }
          return null;
        })
        .filter((p): p is { kind: string; content: string } => p !== null)
    : [];
  const caution =
    typeof src.caution === 'string' && src.caution.trim()
      ? src.caution.trim()
      : typeof src['注意'] === 'string' && src['注意'].trim()
        ? src['注意'].trim()
        : null;
  const summary =
    typeof src.summary === 'string' && src.summary.trim()
      ? src.summary.trim()
      : typeof src['摘要'] === 'string' && src['摘要'].trim()
        ? src['摘要'].trim()
        : points
            .map((p) => p.content)
            .join('；')
            .slice(0, 120);
  return { summary, points, caution };
}

/** 选题包输出归一（2026-09-04，与 normalizeVideoCopy 同模式）：
 * 中文字段名/包装层/difficulty 与 type 的中文值统一映射后过 schema */
export function normalizeVideoTopics(raw: unknown): unknown {
  const src = (raw ?? {}) as Record<string, unknown>;
  const inner =
    src.topics && typeof src.topics === 'object' && !Array.isArray(src.topics)
      ? (src.topics as Record<string, unknown>)
      : src;
  const rawTopics: unknown = Array.isArray(inner.topics)
    ? inner.topics
    : (inner['选题'] ?? src.topics);
  if (!Array.isArray(rawTopics)) return { topics: [], hotNote: null };
  const DIFF: Record<string, string> = {
    低: '低',
    中: '中',
    高: '高',
    easy: '低',
    normal: '中',
    hard: '高',
  };
  const TYPE: Record<string, string> = {
    hot: 'hot',
    evergreen: 'evergreen',
    热点借势: 'hot',
    常青: 'evergreen',
    常青选题: 'evergreen',
  };
  const topics = rawTopics
    .map((t): Record<string, unknown> | null => {
      if (!t || typeof t !== 'object') return null;
      const o = t as Record<string, unknown>;
      const str = (...keys: string[]): string => {
        for (const k of keys) {
          const v = o[k];
          if (typeof v === 'string' && v.trim()) return v.trim();
        }
        return '';
      };
      const title = str('title', '选题', '标题');
      const angle = str('angle', '切入角度', '角度');
      const reason = str('reason', '选题理由', '理由');
      const hook = str('hookDirection', '钩子方向', '钩子');
      const structure = str('structure', '参考结构', '结构');
      if (!title || !angle || !reason || !hook || !structure) return null;
      // 难度/类型兜底取字符串值，防对象值被 String() 成 [object Object]
      const pickStr = (k1: string, k2: string, fb: string): string => {
        const v = o[k1] ?? o[k2];
        return typeof v === 'string' && v.trim() ? v.trim() : fb;
      };
      const diffRaw = pickStr('difficulty', '难度', '中');
      const typeRaw = pickStr('type', '类型', 'evergreen');
      const srcRaw = o.source ?? o['热点来源'];
      return {
        title,
        angle,
        reason,
        hookDirection: hook,
        structure,
        difficulty: DIFF[diffRaw] ?? '中',
        type: TYPE[typeRaw] ?? 'evergreen',
        source: typeof srcRaw === 'string' && srcRaw.trim() ? srcRaw.trim() : null,
      };
    })
    .filter((t): t is Record<string, unknown> => t !== null);
  const hotNoteRaw = inner.hotNote ?? inner['热点说明'];
  return {
    topics,
    hotNote: typeof hotNoteRaw === 'string' && hotNoteRaw.trim() ? hotNoteRaw.trim() : null,
    ...reasoningField(inner, src),
  };
}

/** 标签字段归一（批次B Task 2）：数组取字符串项；字符串按中英文分隔符切分
 * （含顿号——标签是「产品科普、施工过程」式列举）；其他形态为空数组 */
function normalizeTags(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim());
  }
  if (typeof v === 'string' && v.trim()) {
    return v
      .split(/[\s,，;；、]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** 灵感拆解输出归一（批次B Task 2，与 normalizeVideoTopics 同模式）：
 * 中文字段名/dissect 包装层/tags 字符串切分统一归一后过 schema；
 * 纯文本拆不出结构 → 缺字段形状，schema 拒绝（上层 409 引导重试） */
export function normalizeInspirationDissect(raw: unknown): unknown {
  if (typeof raw === 'string' && raw.trim()) {
    return { hookText: '', structure: '', rhythm: null, tags: [], takeaway: '' };
  }
  const src = (raw ?? {}) as Record<string, unknown>;
  const inner =
    src.dissect && typeof src.dissect === 'object' && !Array.isArray(src.dissect)
      ? (src.dissect as Record<string, unknown>)
      : src;
  const str = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = inner[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };
  return {
    hookText: str('hookText', '钩子文案', '钩子') ?? '',
    structure: str('structure', '结构') ?? '',
    rhythm: str('rhythm', '节奏') ?? null,
    tags: normalizeTags(inner.tags ?? inner['标签']),
    takeaway: str('takeaway', '借鉴点', '我们店能借鉴什么') ?? '',
    ...reasoningField(inner, src),
  };
}

/** 灵感扫描输出归一（同模式）：items 数组逐条映射（中英文键）；
 * 缺 platform/title/hookText/structure 任一（对齐灵感库创建端点必填面）的条目丢弃 */
export function normalizeInspirationScan(raw: unknown): unknown {
  const src = (raw ?? {}) as Record<string, unknown>;
  const rawItems: unknown = src.items ?? src['候选'] ?? src['候选灵感'] ?? src.inspirations;
  if (!Array.isArray(rawItems)) return { items: [], scanNote: null };
  const items = rawItems
    .map((t): Record<string, unknown> | null => {
      if (!t || typeof t !== 'object') return null;
      const o = t as Record<string, unknown>;
      const str = (...keys: string[]): string => {
        for (const k of keys) {
          const v = o[k];
          if (typeof v === 'string' && v.trim()) return v.trim();
        }
        return '';
      };
      const platform = str('platform', '平台');
      const title = str('title', '标题');
      const hookText = str('hookText', '钩子文案', '钩子');
      const structure = str('structure', '结构');
      if (!platform || !title || !hookText || !structure) return null;
      const srcRaw = o.sourceUrl ?? o['来源链接'] ?? o['来源'] ?? o['链接'];
      return {
        platform,
        title,
        hookText,
        structure,
        rhythm: str('rhythm', '节奏') || null,
        metrics: str('metrics', '互动数据', '数据') || null,
        tags: normalizeTags(o.tags ?? o['标签']),
        sourceUrl: typeof srcRaw === 'string' && srcRaw.trim() ? srcRaw.trim() : null,
      };
    })
    .filter((t): t is Record<string, unknown> => t !== null);
  const noteRaw = src.scanNote ?? src['扫描说明'];
  return {
    items,
    scanNote: typeof noteRaw === 'string' && noteRaw.trim() ? noteRaw.trim() : null,
  };
}
