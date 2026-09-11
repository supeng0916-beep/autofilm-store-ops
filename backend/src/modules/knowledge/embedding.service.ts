import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AiTaskRepository } from '../ai-dispatch/ai-task.repository';
import { estimateCostFen, parseModelPrices } from '../ai-dispatch/ai-pricing';

/** MiniMax Embedding API 响应 */
interface EmbeddingResponse {
  vectors?: number[][];
  /** 本次计费 token 总数（2026-08-28 实测回传；缺失时计量行如实留空） */
  total_tokens?: number;
  base_resp?: { status_code: number; status_msg: string };
}

/** Embedding 向量化服务（P4-02）：调用 MiniMax Embedding API（国际平台 api.minimaxi.com）。
 * 请求体格式为 { model, texts, type }；type=db 入库向量化、type=query 检索向量化。
 * 未配置 API key 时静默降级返回空数组，不阻塞业务。
 * 2026-08-28 P5 补遗：用量计量——embedding 直连不走 OpenClaw，此前零计量（老板要求成本页
 * 含真实消耗）。每次成功调用写一行 ai_tasks（taskType=knowledge.embed，直接终态 done），
 * tokensIn=API 回传 total_tokens，成本按 ai-pricing 单价估算（embo-01 ¥0.5/百万）。
 * 计量尽力而为：写行失败只告警，不影响向量化返回；近 7 日成本/成本分解/预算熔断自动包含。 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly apiUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly model: string;

  constructor(
    private readonly config: ConfigService,
    private readonly tasks: AiTaskRepository,
  ) {
    this.apiUrl = this.config.get<string>('WG_EMBEDDING_API_URL');
    this.apiKey = this.config.get<string>('WG_EMBEDDING_API_KEY');
    this.model = this.config.get<string>('WG_EMBEDDING_MODEL', 'embo-01');
  }

  /** 是否已配置（API key 就绪） */
  isConfigured(): boolean {
    return !!(this.apiUrl && this.apiKey);
  }

  /** 向量化文本数组 → 返回等长向量数组（维度 1536）。
   * type：'db' 入库向量化（默认）｜'query' 检索向量化（embo-01 为非对称模型） */
  async embed(texts: string[], type: 'db' | 'query' = 'db'): Promise<number[][]> {
    if (!this.isConfigured()) {
      this.logger.warn('Embedding API 未配置，返回空向量');
      return [];
    }
    if (texts.length === 0) return [];

    try {
      const res = await fetch(this.apiUrl!, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: this.model, texts, type }),
      });

      if (!res.ok) {
        this.logger.warn(`Embedding API 返回 ${res.status}`);
        return [];
      }

      const data = (await res.json()) as EmbeddingResponse;
      if (data.base_resp?.status_code !== 0) {
        this.logger.warn(`Embedding API 错误: ${data.base_resp?.status_msg}`);
        return [];
      }

      await this.recordUsage(texts, type, data.total_tokens);
      return data.vectors ?? [];
    } catch (err) {
      this.logger.warn(
        `Embedding API 调用失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /** 用量落库（尽力而为）：失败仅告警不外抛——计量不得影响知识生效/检索主流程。
   * 直连计量行不走派发状态机：一次 create 直接终态 done + 用量字段 */
  private async recordUsage(
    texts: string[],
    type: 'db' | 'query',
    totalTokens: number | undefined,
  ): Promise<void> {
    const tokensIn =
      typeof totalTokens === 'number' && Number.isFinite(totalTokens)
        ? Math.trunc(totalTokens)
        : undefined;
    const costFen =
      tokensIn === undefined
        ? undefined
        : (estimateCostFen(
            this.model,
            tokensIn,
            0,
            parseModelPrices(this.config.get<string>('WG_AI_MODEL_PRICES_FEN_PER_MTOK')),
          ) ?? undefined);
    try {
      await this.tasks.create({
        taskType: 'knowledge.embed',
        inputSummary: JSON.stringify({
          type,
          texts: texts.length,
          chars: texts.reduce((sum, t) => sum + t.length, 0),
        }),
        status: 'done',
        model: this.model,
        ...(tokensIn !== undefined ? { tokensIn, tokensOut: 0 } : {}),
        ...(costFen !== undefined ? { costEstimateFen: costFen } : {}),
      });
    } catch (err) {
      this.logger.warn(
        `Embedding 用量计量失败（不阻断主流程）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
