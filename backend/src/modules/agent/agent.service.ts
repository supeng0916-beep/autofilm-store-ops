import { Injectable, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { PrismaService } from '../../prisma/prisma.service';
import { AiDispatchService } from '../ai-dispatch/ai-dispatch.service';
import { AiTaskRegistry } from '../ai-dispatch/ai-dispatch.registry';
import { bannedWordsIn, lintAgentOutput, type LintResult } from '../ai-dispatch/output-lint';
import { truncateAtSentence } from '../ai-dispatch/output-normalize.util';
import type { JwtPayload } from '../auth/auth.types';
import { BossAggregator } from './aggregators/boss.aggregator';
import { ManagerAggregator } from './aggregators/manager.aggregator';
import { serializeStructuredContext } from './aggregators/role-context';
import type { AgentChatDto } from './dto/agent.dto';
import { PersonaService } from './persona.service';
import type { AgentPersona } from './persona.types';

export const SALES_AGENT_TASK_TYPE = 'sales.agent.chat';
export const BOSS_AGENT_TASK_TYPE = 'boss.agent.chat';
export const MANAGER_AGENT_TASK_TYPE = 'manager.agent.chat';
/** 经营晨报（V1.5 批次2）：同 skill-boss-agent（AI 侧零新技能），taskType 独立便于成本统计/开关 */
export const BOSS_MORNING_BRIEF_TASK_TYPE = 'boss.morning_brief';

/** 共享红线（V1.5 spec §3.4）：boss/manager/sales 三注册统一引用，改一处生效。
 * 在 V1 sales 的 boundary 基础上泛化 + 产出物通用纪律（节制/通俗/分类，技术负责人 2026-09-01 反馈）。 */
export const AGENT_SHARED_CONSTRAINTS = {
  boundary: [
    '仅对员工说话，输出为建议/草稿态，不代行对外动作',
    '报价/优惠/质保等数字仅可引自 knowledgeContext 或 structuredContext，无来源一律引导找店长/老板人工确认',
    '全文简体中文、纯文本排版，平实用词不堆术语，能一句说清不写三句',
    '只在确有必要时产出内容，不编造文件或长文；structuredContext 空区块如实回答暂无',
    '仅行业动态类问题可调用 web_search（≤3 次带来源）',
  ].join('；'),
} as const;

/** 陪练约束（批次6a）：与共享红线同源，补演客户纪律 */
const ROLEPLAY_CONSTRAINTS = {
  boundary: [
    AGENT_SHARED_CONSTRAINTS.boundary,
    'play 模式你扮演客户：演得真、不跳戏不说教、单轮一两句话，不替员工报门店价格',
    'review 模式只依据对话事实点评，改进点≤3条，示范话术不编造价格',
  ].join('；'),
} as const;

/** 输出契约（网关技能侧同款，注册表回调校验依据）：reply 必填、suggestions ≤5 项 ≤50 字；
 * assets=报价图资产 id 列表（≤3，服务端预检索候选，端点富化时校验存在性）；
 * reasoning（T2 决策留痕）：可选 ≤200 字决策说明，落库供门店复盘与经验萃取 */
export const SalesAgentOutputSchema = z.object({
  reply: z.string().min(1),
  suggestions: z.array(z.string().min(1).max(50)).max(5).optional(),
  assets: z.array(z.string().min(1)).max(3).optional(),
  reasoning: z.string().max(200).optional(),
});

/** 晨报输出契约（批次2）：仅 reply（zod 默认剥离技能多输出的 suggestions 等键） */
export const BriefOutputSchema = z.object({ reply: z.string().min(1) });

/** 陪练回合契约（批次6a play 模式）：客户台词+情绪趋势 */
export const RoleplayTurnSchema = z.object({
  reply: z.string().min(1),
  mood: z.enum(['interested', 'neutral', 'annoyed', 'close_deal_hint']).optional(),
});

/** 陪练点评契约（批次6a review 模式）：教练复盘结构 */
export const RoleplayReviewSchema = z.object({
  summary: z.string().min(1),
  strengths: z.array(z.string()).default([]),
  improvements: z.array(z.string()).default([]),
  demo: z.string().optional(),
});

/** 知识预检索条目上限（V1 关键字匹配；2026-08-27 O8 复评 5→8：问「演示品牌车衣质保几年」时
 * 5 条名额被同分价格条目挤占，漏掉 DM12 十年/DM03 十二年等主流款质保——扩到 8 条覆盖完整） */
const KNOWLEDGE_CONTEXT_LIMIT = 8;
/** 同 kind 占席上限（2026-08-27：多样性约束，防 product/price 类霸屏挤出 warranty 汇总条目） */
const KNOWLEDGE_KIND_CAP = 4;
/** 素材图预检索条目上限（2026-08-26 先报价图，同日按老板反馈放开全类型图片素材） */
const ASSET_CANDIDATE_LIMIT = 4;

/** persona → 对话技能包路由（spec §3.1④）：boss/manager 走专属包，sales/general 沿用 V1 */
const personaBundle = (persona: AgentPersona): { taskType: string } => {
  switch (persona) {
    case 'boss':
      return { taskType: BOSS_AGENT_TASK_TYPE };
    case 'manager':
      return { taskType: MANAGER_AGENT_TASK_TYPE };
    default:
      return { taskType: SALES_AGENT_TASK_TYPE };
  }
};

/** Agent 对话服务（2026-08-26 销售 Agent V1；V1.5 分角色路由）：persona 解析 +
 * 知识预检索 + 角色聚合快照注入 + 经 ai-dispatch 提交。
 * 限额/开关/审计/脱敏全部在通道边界强制（submitTask 既有口径）；多轮历史由前端拼接。 */
@Injectable()
export class AgentService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: AiDispatchService,
    private readonly registry: AiTaskRegistry,
    private readonly personaSvc: PersonaService,
    private readonly bossAggregator: BossAggregator,
    private readonly managerAggregator: ManagerAggregator,
  ) {}

  onModuleInit(): void {
    // 载荷键用 staff 而非 salesName：脱敏器将 *name 后缀键按人名打码（A04 先例，asset 的 file 同理）。
    // 输出归一（2026-08-26 门店实测降级修复）：MiniMax 常返回纯文本/markdown 围栏而非严格
    // JSON（踩坑实录「输出形态漂移」），回调校验前确定性翻译，能救的救成 done
    for (const def of [
      // 输出验证接线（2026-09-04 M02 阶段一 Task2）：首批仅 sales 人格挂 postLint
      // （boss/manager 渐进接入）；sales.agent.chat 同时承接 general 人格（personaBundle 默认路由）。
      // v2（2026-09-07 M02 阶段二 Task5 瘦身）：排版/语言细则删出提示词，由 postLint+cleanReplyText 兜底，
      // 详例迁知识库（seed-sales-skill-examples）；红线/契约/受众铁律逐字保留。
      {
        taskType: SALES_AGENT_TASK_TYPE,
        skillName: 'skill-sales-agent',
        postLint: postLintSalesAgentOutput,
        // v2（2026-09-07 M02 阶段二 Task5 瘦身）：排版/语言细则删出提示词，由 postLint+cleanReplyText 兜底，
        // 详例迁知识库（seed-sales-skill-examples）；红线/契约/受众铁律逐字保留。
        // v3（2026-09-07 复盘回补）：AB 二轮实测模型主动写极限词被 lint 拦成任务失败——
        // 技能回补一行文案禁极限词（防员工白等一轮），@v2 快照留档
        // v4（2026-09-02 M02 T2 决策留痕）：输出契约加可选 reasoning（≤200 字决策说明），
        // 落库+前端折叠展示，@v3 快照留档
        // v5（2026-09-09 阶段三 #26/#27 归因）：红线补三条纪律——禁带时长时效承诺、
        // 档位检索子集禁当全档口径、质保加档权限只认老板审批，@v4 快照留档
        skillVersion: 5,
      },
      // 技能 v3（2026-09-07 M02 阶段二 Task3 深查试点）：boss 接入四只读深查工具，manager 仍 v1；
      // v4（2026-09-02 M02 T2 决策留痕）：输出契约加可选 reasoning，@v3 快照留档
      // F06（2026-09-08）：boss/manager 渐进接入 postLint——只拦英文过程泄漏（R1），见函数注释
      {
        taskType: BOSS_AGENT_TASK_TYPE,
        skillName: 'skill-boss-agent',
        skillVersion: 4,
        postLint: postLintBossAgentOutput,
      },
      // v2（2026-09-02 M02 T2 决策留痕）：输出契约加可选 reasoning，@v1 快照留档
      {
        taskType: MANAGER_AGENT_TASK_TYPE,
        skillName: 'skill-manager-agent',
        skillVersion: 2,
        postLint: postLintBossAgentOutput,
      },
    ]) {
      this.registry.register({
        ...def,
        outputSchema: SalesAgentOutputSchema,
        normalize: normalizeSalesAgentOutput,
        deadlineSeconds: 60,
        constraints: AGENT_SHARED_CONSTRAINTS,
        skillVersion: def.skillVersion,
      });
    }
    // 经营晨报（批次2）：复用 skill-boss-agent 技能（零新提示词），输出仅 reply；随 Task3 升 v3
    this.registry.register({
      taskType: BOSS_MORNING_BRIEF_TASK_TYPE,
      skillName: 'skill-boss-agent',
      outputSchema: BriefOutputSchema,
      normalize: normalizeSalesAgentOutput,
      // F06：晨报同挂 R1-only 验证（boss 面向，英文过程泄漏同样不得 done）
      postLint: postLintBossAgentOutput,
      deadlineSeconds: 60,
      constraints: AGENT_SHARED_CONSTRAINTS,
      skillVersion: 3,
    });
    // 销售陪练（批次6a）：双模式同技能——play=AI 演客户，review=教练点评
    this.registry.register({
      taskType: 'sales.roleplay.chat',
      skillName: 'skill-sales-roleplay',
      outputSchema: RoleplayTurnSchema,
      deadlineSeconds: 60,
      constraints: ROLEPLAY_CONSTRAINTS,
      skillVersion: 1,
    });
    this.registry.register({
      taskType: 'sales.roleplay.review',
      skillName: 'skill-sales-roleplay',
      outputSchema: RoleplayReviewSchema,
      deadlineSeconds: 90,
      constraints: ROLEPLAY_CONSTRAINTS,
      skillVersion: 1,
    });
    // 经验卡提炼（批次6b 学习闭环）：陪练/聊天记录 → 建议态经验卡（审批后 sales_method 入库）
    this.registry.register({
      taskType: 'sales.experience.extract',
      skillName: 'skill-experience-extract',
      outputSchema: z.union([
        z.object({
          title: z.string().min(1).max(80),
          content: z.string().min(1).max(600),
          tags: z.array(z.string().min(1).max(12)).max(4).default([]),
        }),
        z.object({ reject: z.string().min(1) }),
      ]),
      deadlineSeconds: 60,
      constraints: {
        boundary:
          '只提炼素材里真实出现过的事实与说法，不编造不补写；素材太薄时输出 reject 如实说明；不诋毁同行、不含极限词、不写门店报价数字',
      },
      skillVersion: 1,
    });
  }

  async chat(
    actor: JwtPayload,
    dto: AgentChatDto,
    onAssistantText?: (cumulativeText: string) => void,
  ) {
    const persona = await this.personaSvc.resolve(actor.sub);
    const knowledgeContext = await this.retrieveKnowledge(dto.message);
    const assetCandidates = await this.retrieveAssetCandidates(dto.message);
    // 分角色路由（spec §3.1④）：boss/manager 注入聚合快照；查询失败降级继续对话（spec §5）
    const aggregator =
      persona === 'boss'
        ? this.bossAggregator
        : persona === 'manager'
          ? this.managerAggregator
          : undefined;
    let structuredContext: string | undefined;
    if (aggregator) {
      const blocks = await aggregator.collect(actor).catch(() => null);
      if (blocks) structuredContext = serializeStructuredContext(blocks);
    }
    return this.dispatch.submitTask(
      personaBundle(persona).taskType,
      {
        persona,
        staff: actor.username,
        message: dto.message,
        history: dto.history.slice(-8),
        ...(knowledgeContext ? { knowledgeContext } : {}),
        ...(assetCandidates.length ? { assetCandidates } : {}),
        ...(structuredContext ? { structuredContext } : {}),
      },
      { type: 'agent', id: actor.sub },
      onAssistantText ? { onAssistantText } : undefined,
    );
  }

  /** 知识预检索（V1 关键字匹配，active 条目 top5，正文截 500 字带来源）：
   * 口径速查必须有来源是红线——命中才有 knowledgeContext，技能侧无上下文不得报价格。
   * 状态口径对齐 knowledge.states（draft→active→expired；曾误写 'effective' 致检索恒空——
   * 2026-08-26 O8 评测前自检发现修复）。
   * 匹配（2026-08-26 价格问答回归两轮修复）：
   * ①大小写不敏感（mode:'insensitive'）——分词统一小写，库内型号多为大写（DM04/Model Y），
   *   大小写敏感会让型号词永远空手而归；
   * ②重合度评分排序（标题命中×2 + 正文命中×1，同分按 updatedAt 新者在前）——纯时间序下
   *   「报价」这类高频词让十几个价格条目互相挤位，把目标条目（如「门店窗膜组合报价」）挤出
   *   top5，AI 拿到无关价格后误答/拒答；标题含多个查询词 = 强相关，必排在前。 */
  private async retrieveKnowledge(message: string): Promise<string | null> {
    const keys = searchTokens(message).slice(0, 12);
    if (keys.length === 0) return null;
    const select = {
      id: true,
      kind: true,
      title: true,
      content: true,
      source: true,
      updatedAt: true,
    } as const;
    const insensitive = (field: 'title' | 'content', t: string) => ({
      [field]: { contains: t, mode: 'insensitive' as const },
    });
    const candidates = await this.prisma.knowledgeItem.findMany({
      where: {
        status: 'active',
        OR: keys.flatMap((t) => [insensitive('title', t), insensitive('content', t)]),
      },
      select,
      orderBy: { updatedAt: 'desc' },
      // 候选池不设小上限（知识库 ~百条量级，全量拉回评分毫无压力）：曾 take 20 按 updatedAt
      // 预截，把时间戳最老的种子条目「门店窗膜组合报价」整条挤出候选池——评分再准也无从选起
      take: 200,
    });
    if (candidates.length === 0) return null;
    const scoreOf = (i: { title: string; content: string }): number => {
      let s = 0;
      for (const t of keys) {
        const hit = (field: string): boolean => field.toLowerCase().includes(t); // 分词已小写；DB 侧 insensitive 预筛，此处评分同口径
        if (hit(i.title)) s += 2;
        if (hit(i.content)) s += 1;
      }
      return s;
    };
    const items = candidates
      .map((i) => ({ i, s: scoreOf(i) }))
      .sort((a, b) => b.s - a.s || b.i.updatedAt.getTime() - a.i.updatedAt.getTime())
      // 同 kind 多样性（2026-08-27 复评质保覆盖修复）：问「演示品牌车衣质保几年」时 8 席曾被 5 条
      // product 条目霸屏，把唯一含 10/12 年档位的 warranty 总表挤出——同一 kind 最多占 4 席，
      // 溢出位按分数让给其他 kind（检索领域标准手法，防单一维度垄断上下文）
      .filter((_, idx, arr) => {
        const kindCount = arr.slice(0, idx).filter((x) => x.i.kind === arr[idx].i.kind).length;
        return kindCount < KNOWLEDGE_KIND_CAP;
      })
      .slice(0, KNOWLEDGE_CONTEXT_LIMIT)
      .map(({ i }) => i);
    return items
      .map(
        (i) => `【${i.kind}】${i.title}｜来源：${i.source ?? '未知'}\n${i.content.slice(0, 500)}`,
      )
      .join('\n\n');
  }

  /** 素材图预检索（2026-08-26 报价图起，同日按老板反馈放开全部类型图片素材）：
   * 报价图/完工案例/施工过程/产品资料中的图片按消息分词匹配 title/carModel/tags，
   * 授权优先、近期优先 top4。未授权素材照常进候选但带 licensed 标记——发不发客户由人工判断
   * （对外动作人工审批红线不变）。仅注入候选元数据，模型不访问文件本身。 */
  private async retrieveAssetCandidates(
    message: string,
  ): Promise<Array<{ id: string; title: string; licensed: boolean }>> {
    const keys = searchTokens(message).slice(0, 12);
    if (keys.length === 0) return [];
    return this.prisma.asset.findMany({
      where: {
        mediaType: 'image',
        OR: keys.flatMap((t) => [
          { title: { contains: t, mode: 'insensitive' } },
          { carModel: { contains: t, mode: 'insensitive' } },
          { tags: { has: t } },
        ]),
      },
      select: { id: true, title: true, licensed: true },
      orderBy: [{ licensed: 'desc' }, { createdAt: 'desc' }],
      take: ASSET_CANDIDATE_LIMIT,
    });
  }

  /** 输出 assets 富化（SSE done 用）：按输出顺序解析存在的图片素材（含授权标记），
   * 未知 id 丢弃（模型编造 id 的兜底——渲染层只见真实存在的候选） */
  async resolveAssetCandidates(
    ids: string[],
  ): Promise<Array<{ id: string; title: string; licensed: boolean }>> {
    if (ids.length === 0) return [];
    const hits = await this.prisma.asset.findMany({
      where: { id: { in: ids }, mediaType: 'image' },
      select: { id: true, title: true, licensed: true },
    });
    const byId = new Map(hits.map((h) => [h.id, h]));
    const out: Array<{ id: string; title: string; licensed: boolean }> = [];
    for (const id of ids) {
      const hit = byId.get(id);
      if (hit && !out.some((o) => o.id === hit.id))
        out.push({ id: hit.id, title: hit.title, licensed: hit.licensed });
    }
    return out.slice(0, ASSET_CANDIDATE_LIMIT);
  }
}

/** 检索分词（知识预检索与报价图预检索共用）：连续字母数字段整段保留；含中文的段补二元滑窗
 * （中文无空格分隔，整段 contains 几乎不可能命中标题——「车衣双膜套餐多少钱」靠「车衣/双膜/套餐」bigram 命中） */
function searchTokens(message: string): string[] {
  const tokens = new Set<string>();
  for (const seg of message.split(/[^\p{L}\p{N}]+/u)) {
    if (seg.length < 2) continue;
    tokens.add(seg.toLowerCase());
    if (/[\u4e00-\u9fff]/.test(seg)) {
      for (let i = 0; i + 2 <= seg.length; i++) tokens.add(seg.slice(i, i + 2));
    }
  }
  return [...tokens];
}

/** 输出归一（注册表 normalize 钩子）：纯文本 → {reply}；markdown 围栏 JSON → 剥离后解析；
 * 对象缺 reply 时从 text/message/content/answer 键兜底（answer 为 2026-08-26 实测漂移形态）；
 * 解析失败原样返回交由 schema 拒绝（降级可观测）。建议追问仅接受字符串数组且截断到 3 条。 */
/** 建议追问清洗（2026-08-26 长度截断补齐）：仅字符串、截 3 条、单条截 50 字——
 * schema 限定每条 ≤50 字，模型偶发输出长句会整单降级（实测「窗膜组合报价」问法两连降级根因之一）。 */
function sanitizeSuggestions(list: unknown[]): string[] {
  return list
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((s) => cleanReplyText(s.slice(0, 50)))
    .filter((s) => s.length > 0)
    .slice(0, 3);
}

/** 决策留痕清洗（T2）：仅非空字符串、截 200 字（与 schema 上限一致）——
 * suggestions 同哲学：模型偶发超长时截断救成 done，不让决策说明把整单拖降级。
 * P3-F02 修复（2026-09-08）：硬截断产残句（评测实测 manager 说明以「以门店」结束）——
 * 改按句边界截断（truncateAtSentence 共享判据，营销路径同款） */
function sanitizeReasoning(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? truncateAtSentence(v.trim(), 200) : undefined;
}

/** 回复确定性清洗（2026-08-27 复评：格式混乱治本）——提示词是概率性约束，这里保证格式下限：
 * ①剥模型英文独白前缀（"I'll read the skill file…"，o8-04 同款泄漏形态）
 * ②markdown 语法转纯文本：围栏/星号加粗/井号标题/分隔线/反引号；表格管道符转全角「｜」并丢弃
 *   |---| 分隔行（保结构可读，聊天界面按纯文本渲染）
 * ③剥 emoji（纯文本聊天显示为乱码；①②③等编号属 Enclosed Alphanumerics 不受影响）。 */
export function cleanReplyText(text: string): string {
  let out = text;
  // ① 前导英文独白行（纯 ASCII 句子），最多剥 3 行
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(
      /^(?:i'll|i will|let me|okay,?|sure,?|first,?|now )[ -~]{0,200}?[.;!]\s*\n?/i,
      '',
    );
    if (next === out) break;
    out = next;
  }
  // ①' 通用英文前置段剥离（2026-08-27 全流程测试 #3：「Looking at the knowledge context…」等
  // 任意英文起手）：本助手面向中文门店，首个中文字符之前的整行英文（自然语言：纯 ASCII、含空格、
  // ≥12 字符）视为模型思考泄漏，逐行丢弃（最多 4 行）；仅当后续确实存在中文正文时才剥。
  {
    const rawLines = out.split('\n');
    let drop = 0;
    while (drop < rawLines.length && drop < 4) {
      const t = rawLines[drop]?.trim() ?? '';
      const letters = (t.match(/[A-Za-z]/g) ?? []).length;
      // 无中文 + 含空格 + ≥12 字符 + 过半是英文字母 = 自然语言英文（em-dash 等排版字符不排斥；
      // 「7.5mil 是演示款」类中英混排行含中文不命中；纯型号代码行字母占比高但无空格短于 12 不命中）
      if (
        !/[\u4e00-\u9fff]/.test(t) &&
        /\s/.test(t) &&
        t.length >= 12 &&
        letters / t.length >= 0.5
      ) {
        drop += 1;
      } else {
        break;
      }
    }
    if (drop > 0 && rawLines.slice(drop).some((l) => /[\u4e00-\u9fff]/.test(l))) {
      rawLines.splice(0, drop);
      out = rawLines.join('\n');
    }
    // 行内混排：行首英文长句后紧跟中文（"English thought. 中文回答"）
    out = out.replace(/^[ -~]{16,}?[.!?:]\s+(?=\P{ASCII})/mu, '');
  }
  // ② markdown → 纯文本（逐行处理，表格行特殊对待）
  const lines = out.split('\n').map((line) => {
    let l = line;
    // 代码围栏行整行丢弃
    if (/^\s*```/.test(l)) return '';
    // 表格分隔行（|---|---| 或 :---:）丢弃
    if (/^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/.test(l) && l.includes('-')) {
      if (l.includes('|') || /^[\s:|-]+$/.test(l)) return '';
    }
    // 表格数据行：半角管道符 → 全角「｜」
    if (l.includes('|')) l = l.replace(/\|/g, '｜').replace(/^｜+|｜+$/g, '');
    // 井号标题 → 去符号
    l = l.replace(/^\s*#{1,6}\s*/, '');
    // 星号/下划线加粗斜体 → 去符号
    l = l.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
    l = l.replace(/__([^_]+)__/g, '$1').replace(/(^|\s)_([^_]+)_(\s|$)/g, '$1$2$3');
    // 反引号 → 去符号
    l = l.replace(/`([^`]*)`/g, '$1');
    // 链接 [text](url) → text
    l = l.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    // 行首 "- " / "* " 列表 → "• "
    l = l.replace(/^\s*[-*]\s+/, '• ');
    return l;
  });
  out = lines.join('\n');
  // 水平分隔线（---/***/___）→ 「——」
  out = out.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '——');
  // ③ emoji 剥离（Extended_Pictographic + 变体选择符/零宽连接符）
  out = out.replace(/(\p{Extended_Pictographic}|\uFE0F|\u200D)/gu, '');
  return out.trim();
}

/** 契约字段值形态（"reply": "…" 等）：坏 JSON 救援与正文混排残渣检测共用 */
const JSON_FIELD_VALUE_RE = /"(?:reply|text|message|content|answer)"\s*:\s*"/;

/** 未解析 JSON 救援（F06 修复，2026-09-08 phase12 评测归因：sales A08/红线29 实测
 * JSON 残渣被当成稿返回）：取首个完整契约字段字符串值（常见漂移：reply 值本身合法
 * 但外层 JSON 破损）；救不回则空 reply——JSON 残渣永远不是成稿，宁可 schema 显式
 * 降级（degraded 可观测、可重试）。英文过程文本的拦截走 postLint R1（failed+lint
 * 反馈重试语义），不在归一层置空——终态区分保持既有口径。 */
function salvageBrokenJsonReply(body: string): string {
  const m = /"(?:reply|text|message|content|answer)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
  if (!m) return '';
  try {
    return cleanReplyText(JSON.parse(`"${m[1]}"`) as string); // 反转义（\n \" 等）
  } catch {
    return cleanReplyText(m[1]); // 末尾残缺转义时按原文清洗
  }
}

/** 输出归一的共享别名（V1.5）：三 taskType 同款归一，新代码用此名 */
export const normalizeAgentOutput = normalizeSalesAgentOutput;

export function normalizeSalesAgentOutput(raw: unknown): unknown {
  if (typeof raw === 'string') {
    const text = raw.trim();
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    const body = fenced ? (fenced[1] ?? '') : text;
    if (body.startsWith('{') || body.startsWith('[')) {
      try {
        return normalizeSalesAgentOutput(JSON.parse(body));
      } catch {
        // F06：坏 JSON 不再整段透传成 reply——先救契约字段，救不回显式降级
        return { reply: salvageBrokenJsonReply(body) };
      }
    }
    // F06：不以 {/[ 起手但混排契约字段残渣（"执行过程 + 未解析 JSON"形态）同口径救援
    if (JSON_FIELD_VALUE_RE.test(body)) {
      return { reply: salvageBrokenJsonReply(body) };
    }
    return { reply: cleanReplyText(text) };
  }
  if (raw && typeof raw === 'object' && !('reply' in raw)) {
    const obj = raw as Record<string, unknown>;
    // 兜底键含 answer：2026-08-26 实测 MiniMax 漂移形态 {answer,citations,confidence}
    const fallback = obj.text ?? obj.message ?? obj.content ?? obj.answer;
    if (typeof fallback === 'string' && fallback.trim()) {
      const out: Record<string, unknown> = { reply: cleanReplyText(fallback) };
      if (Array.isArray(obj.suggestions)) {
        out.suggestions = sanitizeSuggestions(obj.suggestions);
      }
      if (Array.isArray(obj.assets)) out.assets = sanitizeAssetIds(obj.assets);
      const reasoning = sanitizeReasoning(obj.reasoning);
      if (reasoning) out.reasoning = reasoning;
      return out;
    }
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.reply === 'string') obj.reply = cleanReplyText(obj.reply);
    if (
      Array.isArray(obj.suggestions) ||
      Array.isArray(obj.assets) ||
      typeof obj.reply === 'string'
    ) {
      const reasoning = sanitizeReasoning(obj.reasoning);
      // 非法/超长形态不残留透传（合法截断版为准）——防漂移输出把整单拖降级
      delete obj.reasoning;
      return {
        ...obj,
        ...(Array.isArray(obj.suggestions)
          ? { suggestions: sanitizeSuggestions(obj.suggestions) }
          : {}),
        ...(Array.isArray(obj.assets) ? { assets: sanitizeAssetIds(obj.assets) } : {}),
        ...(reasoning ? { reasoning } : {}),
      };
    }
    if (obj.suggestions !== undefined) {
      const rest = { ...obj };
      delete rest.suggestions;
      return rest;
    }
  }
  return raw;
}

/** 输出验证字段提取（M02 阶段一 Task2）：reply 走全量规则（hard+soft）；
 * suggestions 拼接后只保留 hard 违规——建议是短语列表，单条 ≤50 字已由 schema 约束，
 * 拼接长度/markdown 软规则只会制造噪音，而极限词/英文泄漏照样漏不得；
 * reasoning（T2 决策留痕）走全量规则——决策说明同样是落库文本且会前端展示，
 * 中文密度/极限词与 reply 同口径（回声豁免同样适用：解释拒绝时复述用户原词）。
 * 入参已是归一化+schema 校验后的 output（reply 必为非空字符串）。
 * ctx.inputSummary（M02 阶段二回声豁免）：用户让「文案加上行业第一」时，模型的
 * 正确行为是解释拒绝（必然复述原词）——从提交载荷的 message 提取命中的极限词作
 * exemptWords，原词回声降级 soft 留痕，不再 hard 拦成任务失败把系统错误抛给用户。 */
export function postLintSalesAgentOutput(
  output: unknown,
  ctx?: { inputSummary?: string },
): LintResult {
  if (!output || typeof output !== 'object') return { pass: true, issues: [] };
  const { reply, suggestions, reasoning } = output as {
    reply?: unknown;
    suggestions?: unknown;
    reasoning?: unknown;
  };
  const exemptWords = exemptWordsFromSummary(ctx?.inputSummary);
  const fields: Record<string, string> = {};
  if (typeof reply === 'string' && reply.trim()) fields.reply = reply;
  if (typeof reasoning === 'string' && reasoning.trim()) fields.reasoning = reasoning;
  const result = lintAgentOutput(fields, { exemptWords });
  if (Array.isArray(suggestions)) {
    const joined = suggestions
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .join('\n');
    if (joined.trim()) {
      const sugg = lintAgentOutput({ suggestions: joined }, { exemptWords });
      result.issues.push(...sugg.issues.filter((i) => i.severity === 'hard'));
    }
  }
  return { pass: !result.issues.some((i) => i.severity === 'hard'), issues: result.issues };
}

/** boss/manager 人格输出验证（F06 修复，2026-09-08 phase12 评测归因：boss B04 整段
 * 英文执行过程照落 done——注册表原口径「首批仅 sales 挂 postLint，boss/manager 渐进
 * 接入」，本函数即渐进接入的第一步）。只拦英文过程泄漏（R1 cjk-density）：内部经营
 * 分析对话不适用广告法极限词红线（R3 面向对客成稿），markdown/超长软规则对 boss 通道
 * 是噪音——非 R1 命中一律不报。终态与 sales 同口径：failed（「lint 拦截」前缀，可
 * 手动 retry 带 lintFeedback 知因再答），不再把不可读正文当 done 落库。
 * 晨报（boss 面向、同技能包）复用本函数。 */
export function postLintBossAgentOutput(output: unknown): LintResult {
  if (!output || typeof output !== 'object') return { pass: true, issues: [] };
  const { reply, reasoning } = output as { reply?: unknown; reasoning?: unknown };
  const fields: Record<string, string> = {};
  if (typeof reply === 'string' && reply.trim()) fields.reply = reply;
  if (typeof reasoning === 'string' && reasoning.trim()) fields.reasoning = reasoning;
  const kept = lintAgentOutput(fields).issues.filter((i) => i.rule === 'cjk-density');
  return { pass: !kept.some((i) => i.severity === 'hard'), issues: kept };
}

/** 回声豁免表提取：inputSummary 是提交载荷的脱敏 JSON（message 原词在内——脱敏器
 * 只处理手机号/微信/车牌/地址/姓名，不碰极限词）。只取 message：豁免口径=用户本轮
 * 原词，history/knowledgeContext 不算。
 * F03 修复（2026-09-08）：解析失败（历史行的摘要超 2000 被硬截断）时不再整串扫描
 * ——旧兜底把 knowledgeContext/history/lintFeedback 里的极限词全部误当用户回声豁免，
 * 顺从性广告成稿被放行（lint-truncated-summary 生产函数复现）。现在用字段正则只取
 * message 值：chat 载荷 message 字段靠前（persona/staff 之后），2000 截断下通常完整；
 * 无收尾引号（message 自身被截）时取剩余串——仍限于 message 字段内部。提不出
 * message 则 fail-closed 返回空表：宁可 hard 拦走重试，不误豁免放行。
 * 源头侧另有 buildInputSummary 字段级截断（新任务摘要保持合法 JSON），双保险。 */
function exemptWordsFromSummary(inputSummary: string | undefined): string[] {
  if (!inputSummary) return [];
  let message: unknown;
  try {
    const parsed: unknown = JSON.parse(inputSummary);
    message =
      parsed && typeof parsed === 'object' ? (parsed as { message?: unknown }).message : undefined;
  } catch {
    const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(inputSummary);
    if (!m) return [];
    try {
      message = JSON.parse(`"${m[1]}"`); // 反转义（\\" → " 等）；组1不含收尾引号
    } catch {
      message = m[1]; // 末尾残缺转义（截断切在 \\ 中间）时按原文扫描
    }
  }
  return typeof message === 'string' ? bannedWordsIn(message) : [];
}

/** assets 输出清洗：仅字符串、去重、截 3（存在性由 resolveQuoteAssets 富化时兜底） */
function sanitizeAssetIds(list: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of list) {
    if (typeof x !== 'string' || !x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out.slice(0, 3);
}
