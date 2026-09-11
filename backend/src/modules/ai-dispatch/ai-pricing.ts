/** 模型单价与成本估算（2026-08-28 P5）：网关只回传 token 不回传金额（未配置模型计价，
 * sessions.usage 的 cost 恒为 0、missingCostEntries>0）——后端按单价表估算成本（分），
 * 网关上报金额时优先上报值。单价口径：分 / 每百万 tokens。 */

export interface ModelPriceFen {
  /** 输入单价（分/百万 tokens） */
  input: number;
  /** 输出单价（分/百万 tokens） */
  output: number;
}

/** 内置默认单价（分/百万 tokens）。主模型 MiniMax-M3：开放平台 2026-08 公示价（永久五折后
 * 输入 ¥2.1/M、输出 ¥4.2/M）。embedding 模型 embo-01：官方定价 ¥0.0005/千 tokens =
 * ¥0.5/M（embedding 仅按输入 token 计费，无输出）。
 * 门店更换供应商/调价时用 WG_AI_MODEL_PRICES_FEN_PER_MTOK 覆盖（JSON，与该表同结构合并）。 */
export const DEFAULT_MODEL_PRICES_FEN_PER_MTOK: Record<string, ModelPriceFen> = {
  'MiniMax-M3': { input: 210, output: 420 },
  'embo-01': { input: 50, output: 0 },
};

/** 解析 env 单价配置（WG_AI_MODEL_PRICES_FEN_PER_MTOK，JSON 字符串）并与内置默认合并；
 * 非法 JSON / 非法结构整体忽略（仅用默认表）——计价属估算口径，不因配置笔误阻断记账。 */
export function parseModelPrices(raw: string | undefined): Record<string, ModelPriceFen> {
  if (!raw?.trim()) return { ...DEFAULT_MODEL_PRICES_FEN_PER_MTOK };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null)
      return { ...DEFAULT_MODEL_PRICES_FEN_PER_MTOK };
    const merged: Record<string, ModelPriceFen> = { ...DEFAULT_MODEL_PRICES_FEN_PER_MTOK };
    for (const [model, price] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof model === 'string' &&
        typeof price === 'object' &&
        price !== null &&
        Number.isFinite((price as { input?: unknown }).input) &&
        Number.isFinite((price as { output?: unknown }).output)
      ) {
        merged[model] = {
          input: (price as { input: number }).input,
          output: (price as { output: number }).output,
        };
      }
    }
    return merged;
  } catch {
    return { ...DEFAULT_MODEL_PRICES_FEN_PER_MTOK };
  }
}

/** 按单价估算成本（分，四舍五入）：tokens/1e6 × 单价。模型无单价返回 null（如实留空，不估 0）。 */
export function estimateCostFen(
  model: string | undefined,
  tokensIn: number,
  tokensOut: number,
  prices: Record<string, ModelPriceFen>,
): number | null {
  if (!model) return null;
  const price = prices[model] ?? prices[model.toLowerCase()] ?? prices[model.toUpperCase()];
  if (!price) return null;
  return Math.round((tokensIn / 1e6) * price.input + (tokensOut / 1e6) * price.output);
}
