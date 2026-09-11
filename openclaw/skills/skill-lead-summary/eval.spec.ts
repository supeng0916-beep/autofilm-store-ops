/**
 * skill-lead-summary 合成评测（P3-05）：V1 echo 模式验证管线。
 *
 * 职责：证明「评测 harness」能正确测量输出 schema 符合率——以 fake/echo 通道回显合法输出，
 * 经手写 schema 校验器统计符合率并断言 ≥95%；同时验证校验器能识破畸形输出（缺 summary / 空 nextAction）。
 *
 * 真实模型符合率为手工步骤（按 docs/dev-setup.md runbook 跑真模型后记录），不在此脚本内。
 *
 * 运行方式（Node ≥22.6 或经 tsx，无外部依赖）：
 *   node --experimental-strip-types openclaw/skills/skill-lead-summary/eval.spec.ts
 *   # 或
 *   cd backend && npx tsx ../openclaw/skills/skill-lead-summary/eval.spec.ts
 *
 * 数据源：同目录 eval-cases.json（全合成，零真实客户数据）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 与 backend LeadSummaryOutputSchema 对齐的最小校验器（避免跨项目引 zod）。
 * 必填：summary/nextAction 为非空字符串；concerns/questionsToAsk 若存在须为字符串数组；
 * visitPitch/escalationHint 若存在须为字符串。 */
interface ValidateResult {
  ok: boolean;
  errors: string[];
}

function validateSummaryOutput(value: unknown): ValidateResult {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['输出必须是 JSON 对象'] };
  }
  const out = value as Record<string, unknown>;
  if (typeof out.summary !== 'string' || out.summary.length === 0) {
    errors.push('summary 缺失或为空串');
  }
  if (typeof out.nextAction !== 'string' || out.nextAction.length === 0) {
    errors.push('nextAction 缺失或为空串');
  }
  for (const key of ['concerns', 'questionsToAsk'] as const) {
    const v = out[key];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
      errors.push(`${key} 若存在须为字符串数组`);
    }
  }
  for (const key of ['visitPitch', 'escalationHint'] as const) {
    const v = out[key];
    if (v !== undefined && typeof v !== 'string') {
      errors.push(`${key} 若存在须为字符串`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** fake/echo 通道：依据上下文回显一条合法 lead.summary 输出（不调模型，纯管线验证）。 */
interface SummaryContext {
  refId?: unknown;
  sourcePlatform?: unknown;
  businessType?: unknown;
  target?: unknown;
  productNeed?: unknown;
  rawNeed?: unknown;
  stage?: unknown;
  lastFollowUpResult?: unknown;
}

function echoOutput(context: SummaryContext): Record<string, unknown> {
  const source = typeof context.sourcePlatform === 'string' ? context.sourcePlatform : '未知渠道';
  const need =
    typeof context.productNeed === 'string' && context.productNeed
      ? context.productNeed
      : typeof context.rawNeed === 'string' && context.rawNeed
        ? context.rawNeed.slice(0, 20)
        : '待确认需求';
  const target =
    typeof context.target === 'string' && context.target ? `（${context.target}）` : '';
  return {
    summary: `客户经${source}咨询${need}${target}，意向待跟进确认。`,
    concerns: ['价格预算'],
    questionsToAsk: ['是否已确定具体需求？'],
    nextAction: '联系客户确认意向',
    visitPitch: '到店可实地看样板与实车效果',
    escalationHint: '若连续两天未回复，建议店长介入',
  };
}

interface EvalCase {
  id: string;
  name: string;
  context: SummaryContext;
}

function loadCases(): EvalCase[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, 'eval-cases.json'), 'utf8');
  const parsed = JSON.parse(raw) as { cases?: EvalCase[] };
  assert(Array.isArray(parsed.cases), 'eval-cases.json 缺少 cases 数组');
  return parsed.cases;
}

function main(): void {
  const cases = loadCases();
  assert(cases.length >= 20, `评测集应 ≥20 条，实际 ${cases.length} 条`);

  let validCount = 0;
  for (const c of cases) {
    const output = echoOutput(c.context);
    const result = validateSummaryOutput(output);
    if (result.ok) validCount += 1;
    else console.error(`[FAIL] ${c.id} ${c.name}: ${result.errors.join('；')}`);
  }
  const rate = validCount / cases.length;
  console.log(`lead.summary echo 评测：${validCount}/${cases.length} 符合，符合率 ${(rate * 100).toFixed(1)}%`);

  // 主断言：符合率 ≥95%（echo 管线应 100%，阈值对齐真实模型验收口径）
  assert(rate >= 0.95, `符合率 ${(rate * 100).toFixed(1)}% 低于 95% 阈值`);

  // 校验器须能识破畸形输出（证明 harness 可测量真实模型的不符合项）
  assert(!validateSummaryOutput({}).ok, '空对象应判为不符合');
  assert(!validateSummaryOutput({ summary: 'x' }).ok, '缺 nextAction 应判为不符合');
  assert(
    !validateSummaryOutput({ summary: '', nextAction: 'x' }).ok,
    '空 summary 应判为不符合',
  );
  console.log('畸形输出识别：通过（空对象/缺 nextAction/空 summary 均被拒绝）');
}

main();
