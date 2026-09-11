import { Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../../common/audit';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../auth/auth.types';
import { AiDispatchService } from '../ai-dispatch/ai-dispatch.service';
import { RagService, extractRecallTokens, type RagSearchResult } from './rag.service';

/** 知识检索请求 */
export interface KnowledgeSearchRequest {
  query: string;
}

/** 素材引用卡片（V2.3b）：确定性元数据匹配，图片不做向量化 */
export interface KnowledgeAssetRef {
  id: string;
  title: string;
  kind: string;
  carModel: string | null;
  licensed: boolean;
}

/** 知识检索响应（确定性代码路径，不经 AI 时直接返回）。
 * assets 为 V2.3b 新增字段：仅追加不改动既有字段，旧消费方不受影响。 */
export interface KnowledgeSearchResponse {
  query: string;
  results: Array<{
    chunkText: string;
    itemTitle: string;
    kind: string;
    source: string | null;
    licensed: boolean;
    version: number;
    similarity: number;
  }>;
  assets: KnowledgeAssetRef[];
  answer: string;
  confidence: string;
  uncertainReason: string | null;
}

/** 素材确定性匹配上限（V2.3b：引用卡片而非列表页） */
const ASSET_MATCH_LIMIT = 3;

/** 知识检索服务（P4-03）：RAG 检索 + AI 格式化。
 * 确定性代码做检索，AI 只做格式化——无来源时直接拒绝，不编造。
 * V2.3b：响应追加 assets 引用数组——query 分词命中素材元数据（title/carModel/productModel），
 * 仅 licensed=true 可被引用（与知识 licensed 语义一致）；随 payload 附给模型作上下文，
 * skill 提示词不改（A08：模型不引用也不影响 schema）。 */
@Injectable()
export class KnowledgeSearchService {
  private readonly logger = new Logger(KnowledgeSearchService.name);

  constructor(
    private readonly rag: RagService,
    private readonly ai: AiDispatchService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  /** 检索知识库：RAG 检索 → 提交 AI 格式化 → 返回结构化结果 */
  async search(actor: JwtPayload, req: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> {
    // 0. 素材确定性匹配（V2.3b）：独立于 RAG，知识无命中时素材卡片仍可返回
    const assets = await this.matchAssets(req.query);

    // 1. RAG 检索（仅返回 active + licensed 的结果）
    const ragResults = await this.rag.search(req.query, 10);

    // 2. 过滤：仅保留已授权素材
    const licensed = ragResults.filter((r) => r.licensed);

    // 3. 无结果 → 直接拒绝，不走 AI（A05：无来源拒绝确定性回答）
    if (licensed.length === 0) {
      return {
        query: req.query,
        results: [],
        assets,
        answer: '无法确定，需人工核实',
        confidence: 'uncertain',
        uncertainReason: '知识库中未找到相关信息',
      };
    }

    // 4. 提交 AI 格式化（仅格式化，不编造）；assets 仅作上下文附加（A08）
    try {
      const task = await this.ai.submitTask(
        'knowledge.search',
        {
          query: req.query,
          results: licensed.map((r) => ({
            chunkText: r.chunkText,
            itemTitle: r.itemTitle,
            kind: r.kind,
            source: r.source,
            licensed: r.licensed,
            itemVersion: r.itemVersion,
            similarity: Math.round(r.similarity * 100) / 100,
          })),
          assets,
        },
        { type: 'knowledge_search', id: actor.sub },
      );

      const output = task.output as {
        answer?: string;
        citations?: Array<{ title: string; kind: string; source: string | null; version: number }>;
        confidence?: string;
        uncertainReason?: string;
      } | null;

      return {
        query: req.query,
        results: licensed.map(formatResult),
        assets,
        answer: output?.answer ?? '无法确定，需人工核实',
        confidence: output?.confidence ?? 'uncertain',
        uncertainReason: output?.uncertainReason ?? null,
      };
    } catch (err) {
      // AI 降级：直接返回 RAG 结果摘要
      this.logger.warn(
        `知识检索 AI 格式化失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.fallbackResponse(req.query, licensed, assets);
    }
  }

  /** 素材确定性匹配（V2.3b）：分词复用 RAG 的 extractRecallTokens（型号词+中文三元组），
   * 命中 title/carModel/productModel 任一字段；仅 licensed=true 进入引用（对外口径） */
  private async matchAssets(query: string): Promise<KnowledgeAssetRef[]> {
    const tokens = extractRecallTokens(query);
    if (tokens.length === 0) return [];
    const contains = (t: string) => ({ contains: t, mode: 'insensitive' as const });
    return this.prisma.asset.findMany({
      where: {
        licensed: true,
        OR: tokens.flatMap((t) => [
          { title: contains(t) },
          { carModel: contains(t) },
          { productModel: contains(t) },
        ]),
      },
      select: { id: true, title: true, kind: true, carModel: true, licensed: true },
      orderBy: { createdAt: 'desc' },
      take: ASSET_MATCH_LIMIT,
    });
  }

  /** AI 降级响应：直接汇总 RAG 结果 */
  private fallbackResponse(
    query: string,
    results: RagSearchResult[],
    assets: KnowledgeAssetRef[],
  ): KnowledgeSearchResponse {
    if (results.length === 0) {
      return {
        query,
        results: [],
        assets,
        answer: '无法确定，需人工核实',
        confidence: 'uncertain',
        uncertainReason: '知识库中未找到相关信息',
      };
    }
    const top = results.slice(0, 3);
    return {
      query,
      results: results.map(formatResult),
      assets,
      answer: `找到 ${results.length} 条相关知识（AI 暂不可用，以下为原始检索结果）：\n${top.map((r) => `· ${r.itemTitle}（${r.kind}）：${r.chunkText.slice(0, 200)}`).join('\n')}`,
      confidence: 'low',
      uncertainReason: 'AI 格式化服务暂不可用，展示原始检索结果',
    };
  }
}

function formatResult(r: RagSearchResult) {
  return {
    itemId: r.itemId,
    chunkText: r.chunkText,
    itemTitle: r.itemTitle,
    kind: r.kind,
    source: r.source,
    licensed: r.licensed,
    version: r.itemVersion,
    similarity: Math.round(r.similarity * 100) / 100,
  };
}
