import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';

/** RAG 检索结果 */
export interface RagSearchResult {
  chunkText: string;
  itemId: string;
  itemVersion: number;
  itemTitle: string;
  kind: string;
  source: string | null;
  licensed: boolean;
  /** 余弦距离（越小越相似） */
  similarity: number;
  /** 召回方式：vector=向量相似；keyword=型号词确定性命中（P4-06 校准新增） */
  matchedBy?: 'vector' | 'keyword';
}

/** 关键词召回词提取（确定性，P4-06 校准）：
 * 1) 字母开头的字母数字连串（≥2 字符）——型号词，如 DM03/DM24/DM04/DM25；
 * 2) 中文连续段（≥3 字符）的 3 元组——中文专名/短语，如「演示入门款什么价格」→ 演示款/示款式/…
 *    （embo-01 对纯中文专名短问句的向量相似度同样偏低，0.27 量级，三元组命中标题兜底召回） */
export function extractRecallTokens(query: string): string[] {
  const alnum = query.match(/[A-Za-z][A-Za-z0-9]{1,}/g) ?? [];
  const cjkRuns = query.match(/[\u4e00-\u9fff]{3,}/g) ?? [];
  const trigrams: string[] = [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 3 <= run.length; i++) trigrams.push(run.slice(i, i + 3));
  }
  return [...new Set([...alnum, ...trigrams])];
}

/** RAG 分块参数 */
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 100;

/** RAG 检索管道（P4-02）：文本分块→向量化→pgvector 写入→相似度检索 */
@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
    private readonly config: ConfigService,
  ) {}

  /** 将文本按字符分块（含重叠） */
  chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
    if (!text || text.trim().length === 0) return [];
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + size, text.length);
      chunks.push(text.slice(start, end));
      if (end >= text.length) break;
      start += size - overlap;
    }
    return chunks;
  }

  /** 为知识条目生成向量并写入：分块→向量化→INSERT。
   * 先建后切：先写入新向量，再删旧向量（事务保证）。 */
  async indexItem(itemId: string, itemVersion: number, content: string): Promise<number> {
    if (!this.embedding.isConfigured()) {
      this.logger.warn(`Embedding 未配置，跳过 ${itemId} 向量化`);
      return 0;
    }

    const chunks = this.chunkText(content);
    if (chunks.length === 0) return 0;

    const vectors = await this.embedding.embed(chunks);
    if (vectors.length === 0) return 0;

    return this.prisma.$transaction(async (tx) => {
      // 先建：INSERT 新版本向量
      let inserted = 0;
      for (let i = 0; i < chunks.length; i++) {
        await tx.$executeRawUnsafe(
          `INSERT INTO knowledge_embeddings (id, item_id, item_version, chunk_text, embedding, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4::vector, NOW())`,
          itemId,
          itemVersion,
          chunks[i],
          this.vectorToSql(vectors[i]),
        );
        inserted++;
      }

      // 后切：删除旧版本向量
      await tx.$executeRawUnsafe(
        `DELETE FROM knowledge_embeddings WHERE item_id = $1 AND item_version != $2`,
        itemId,
        itemVersion,
      );

      return inserted;
    });
  }

  /** 删除知识条目的所有向量 */
  async deleteItemVectors(itemId: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM knowledge_embeddings WHERE item_id = $1`,
      itemId,
    );
  }

  /** 语义检索（混合，P4-06 校准）：向量相似 + 型号词确定性强制召回。
   * 背景：embo-01 对「无品牌前缀的短型号问句」（如 DM03多少钱）区分度弱——
   * 实测正确条目相似度 0.04 而错误条目 0.21，纯向量路径会漏检并可能错检；
   * 关键词命中的条目不受相似度阈值约束（S11：确定性规则优先于模型）。
   * 仅返回 status='active' 的知识条目结果；关键词命中排在向量结果之前。 */
  async search(query: string, limit = 10): Promise<RagSearchResult[]> {
    if (!this.embedding.isConfigured()) {
      this.logger.warn('Embedding 未配置，检索返回空');
      return [];
    }

    const [queryVector] = await this.embedding.embed([query], 'query');
    if (!queryVector || queryVector.length === 0) return [];

    // 相似度阈值（默认 0 关闭）：开启后低于阈值的结果不返回，
    // 使无关查询走「无法确定，需人工核实」拒绝路径（A05），而非拿弱相关内容作答
    const minSimilarity = Number(this.config.get('WG_RAG_MIN_SIMILARITY', 0)) || 0;
    const thresholdClause = minSimilarity > 0 ? 'AND 1 - (ke.embedding <=> $1::vector) >= $3' : '';
    const params: unknown[] = [this.vectorToSql(queryVector), limit];
    if (minSimilarity > 0) params.push(minSimilarity);

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        chunk_text: string;
        item_id: string;
        item_version: number;
        item_title: string;
        kind: string;
        source: string | null;
        licensed: boolean;
        similarity: number;
      }>
    >(
      `SELECT
        ke.chunk_text,
        ke.item_id,
        ke.item_version,
        ki.title AS item_title,
        ki.kind,
        ki.source,
        ki.licensed,
        1 - (ke.embedding <=> $1::vector) AS similarity
      FROM knowledge_embeddings ke
      JOIN knowledge_items ki ON ke.item_id = ki.id
      WHERE ki.status = 'active' ${thresholdClause}
      ORDER BY ke.embedding <=> $1::vector
      LIMIT $2`,
      ...params,
    );

    const vectorResults = rows.map((r) => ({
      chunkText: r.chunk_text,
      itemId: r.item_id,
      itemVersion: r.item_version,
      itemTitle: r.item_title,
      kind: r.kind,
      source: r.source,
      licensed: r.licensed,
      similarity: Number(r.similarity),
      matchedBy: 'vector' as const,
    }));

    // 型号词强制召回：不受阈值约束，与向量结果按 (itemId, chunk) 去重后置顶
    const keywordResults = await this.keywordRecall(query, queryVector, limit);
    const seen = new Set(keywordResults.map((r) => `${r.itemId}:${r.chunkText}`));
    const merged = [...keywordResults];
    for (const r of vectorResults) {
      const k = `${r.itemId}:${r.chunkText}`;
      if (!seen.has(k)) {
        merged.push(r);
        seen.add(k);
      }
    }
    return merged.slice(0, Math.max(limit, keywordResults.length));
  }

  /** 关键词召回（分层，P4-06 校准）：
   * 查询含型号词（字母数字）→ 仅按型号词词边界精确召回——避免「多少钱」等通用
   * 三元组把全量价格条目灌入召回集、再被失真的向量排序错排（实测教训）；
   * 无型号词 → 按中文三元组召回，兜底纯中文专名问句（如「演示入门款什么价格」） */
  private async keywordRecall(
    query: string,
    queryVector: number[],
    limit: number,
  ): Promise<RagSearchResult[]> {
    const tokens = extractRecallTokens(query);
    if (tokens.length === 0) return [];
    const alnum = tokens.filter((t) => /^[A-Za-z][A-Za-z0-9]+$/.test(t));
    const use = alnum.length > 0 ? alnum : tokens;
    // 型号词加词边界防 DM12 误命中 DM03；中文三元组直接子串匹配；token 均无需转义
    const parts = use.map((t) =>
      /^[A-Za-z0-9]+$/.test(t) ? `(^|[^A-Za-z0-9])${t}([^A-Za-z0-9]|$)` : t,
    );
    const pattern = parts.join('|');
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        chunk_text: string;
        item_id: string;
        item_version: number;
        item_title: string;
        kind: string;
        source: string | null;
        licensed: boolean;
        similarity: number;
      }>
    >(
      `SELECT
        ke.chunk_text,
        ke.item_id,
        ke.item_version,
        ki.title AS item_title,
        ki.kind,
        ki.source,
        ki.licensed,
        1 - (ke.embedding <=> $1::vector) AS similarity
      FROM knowledge_embeddings ke
      JOIN knowledge_items ki ON ke.item_id = ki.id
      WHERE ki.status = 'active' AND (ki.title ~* $2 OR ke.chunk_text ~* $2)
      ORDER BY ke.embedding <=> $1::vector
      LIMIT $3`,
      this.vectorToSql(queryVector),
      pattern,
      limit,
    );
    return rows.map((r) => ({
      chunkText: r.chunk_text,
      itemId: r.item_id,
      itemVersion: r.item_version,
      itemTitle: r.item_title,
      kind: r.kind,
      source: r.source,
      licensed: r.licensed,
      similarity: Number(r.similarity),
      matchedBy: 'keyword' as const,
    }));
  }

  /** 将 number[] 转为 PostgreSQL vector 字面量 '[1.0,2.0,...]' */
  private vectorToSql(vec: number[]): string {
    return `[${vec.join(',')}]`;
  }
}
