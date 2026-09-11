import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { AiDispatchModule } from '../ai-dispatch/ai-dispatch.module';
import { AiTaskRegistry } from '../ai-dispatch/ai-dispatch.registry';
import { normalizeKnowledgeSearch } from './knowledge-normalize';

/** knowledge.search 输出 schema（P4-03）：基于知识库的确定性回答+来源引用+置信度。
 * 即回调校验依据；输出只落 ai_tasks.output 建议态，绝不写业务字段。 */
export const KnowledgeSearchOutputSchema = z.object({
  answer: z.string().min(1),
  citations: z
    .array(
      z.object({
        title: z.string(),
        kind: z.string(),
        source: z.string().nullable(),
        version: z.number(),
      }),
    )
    .default([]),
  confidence: z.enum(['high', 'medium', 'low', 'uncertain']),
  uncertainReason: z.string().nullable().default(null),
});

export type KnowledgeSearchOutput = z.infer<typeof KnowledgeSearchOutputSchema>;

/** knowledge.search 约束（A05）：行为边界随 constraints 下发 */
export const KNOWLEDGE_SEARCH_CONSTRAINTS = {
  boundary:
    '仅依据知识库检索结果回答，不编造事实，不报价，不承诺，未经授权素材不对外引用；无结果时输出"无法确定，需人工核实"',
};

/** knowledge.search 注册（P4-03）：OnModuleInit 向全局注册表登记 taskType */
@Injectable()
export class KnowledgeAiRegistrations implements OnModuleInit {
  constructor(private readonly registry: AiTaskRegistry) {}

  onModuleInit(): void {
    this.registry.register({
      taskType: 'knowledge.search',
      skillName: 'skill-knowledge-search',
      outputSchema: KnowledgeSearchOutputSchema,
      normalize: normalizeKnowledgeSearch,
      deadlineSeconds: 60,
      constraints: KNOWLEDGE_SEARCH_CONSTRAINTS,
    });
  }
}

/** 知识库 AI 子模块（P4-03）：注册 knowledge.search + 检索端点 */
@Module({
  imports: [AiDispatchModule],
  providers: [KnowledgeAiRegistrations],
})
export class KnowledgeAiModule {}
