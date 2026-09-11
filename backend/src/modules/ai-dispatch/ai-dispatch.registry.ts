import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { LintResult } from './output-lint';

/** taskType 登记项：skill 映射 + 输出 Zod schema（规格 §5.2 校验依据）+ 默认时限 */
export interface AiTaskDef {
  taskType: string;
  skillName: string;
  outputSchema: z.ZodType;
  /** 未设置时用 WG_AI_DISPATCH_DEADLINE_S */
  deadlineSeconds?: number;
  /** 技能提示词版本（V1.5 批次5）：与 SKILL.md frontmatter version 同步维护，
   * 提交时落 ai_tasks.skill_version——影子对比与回滚观测依据 */
  skillVersion?: number;
  /** 随提交载荷下发的固定约束（模型行为边界，供 skill 提示词引用） */
  constraints?: Record<string, unknown>;
  /** 输出归一化钩子（2026-08-21）：回调校验前的确定性翻译（S11 口径，marketing 先例）。
   * 纯函数：只翻译模型输出漂移（别名键/类型互串/枚举别名），不编造内容、不放宽契约；
   * 归一后仍不过 outputSchema 的输出照常降级。 */
  normalize?: (raw: unknown) => unknown;
  /** 输出验证钩子（2026-09-04 M02 阶段一 Task2）：outputSchema 校验通过后执行
   * （入参为归一化+校验后的 output）。hard 违规 → 任务 failed（errorMessage 记
   * lint:<rule>，failed 可走既有重试）；soft 违规 → Logger.warn 留痕、输出不动。
   * 未挂接的任务行为与原先完全一致（渐进接入，首批仅 sales.agent.chat）。
   * ctx.inputSummary（2026-09-07 M02 阶段二）：提交载荷的脱敏 JSON 摘要，
   * 供 lint 判「用户输入原词回声」类豁免；不关心的钩子可不读（单参函数照常挂接）。 */
  postLint?: (output: unknown, ctx?: { inputSummary?: string }) => LintResult;
}

/** hello 输出 schema：P2 通道验证用最小契约 */
export const HelloOutputSchema = z.object({
  greeting: z.string().min(1),
  model: z.string().optional(),
});

@Injectable()
export class AiTaskRegistry {
  private readonly defs = new Map<string, AiTaskDef>();

  constructor() {
    // P2 唯一登记项；§5.3 五个业务 skill 随 P3/P4 模块落地时在此追加（不改架构，规格 §5.3 尾段）
    this.register({
      taskType: 'hello',
      skillName: 'skill-hello',
      outputSchema: HelloOutputSchema,
      constraints: { boundary: '通道验证任务，不得访问任何工具' },
    });
  }

  register(def: AiTaskDef): void {
    this.defs.set(def.taskType, def);
  }

  /** 未注册 taskType 属编程错误：VALIDATION_FAILED 带明确 detail */
  get(taskType: string): AiTaskDef {
    const def = this.defs.get(taskType);
    if (!def) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, `未注册的 taskType: ${taskType}`);
    }
    return def;
  }

  list(): AiTaskDef[] {
    return [...this.defs.values()];
  }
}
