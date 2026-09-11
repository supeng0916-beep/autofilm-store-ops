import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** sales-cases.json 静态校验（M02 Task 4，A2 瘦身前 v1 基线输入集）：
 * 数量（30）/ id 与 message 去重 / expect 完备（每条至少一个确定性断言）/
 * 七类分布（话术6/报价5/店知识5/素材3/搜索3/闲聊3/边界5）/
 * 与既有评测集（boss-cases、eval-cases-chat）跨文件不重复。
 * M-1 修复：报价类用例的每个金额锚词都必须同时提供纯数字与千分位格式。
 * M-2 修复：边界红线用例（ab-26/27/28/30）挂 expect.boundary 正则标记且保留合规引导词。
 * 用例格式与 boss-cases.json 一致（id/category/message/expect），加载方 scripts/eval.ts。 */

interface ChatCase {
  id: string;
  category: string;
  message: string;
  expect: {
    coach?: boolean;
    contains?: string[];
    containsAny?: string[];
    boundary?: string;
  };
}

function loadCases(name: string): ChatCase[] {
  return (JSON.parse(readFileSync(join(__dirname, 'eval', name), 'utf8')) as { cases: ChatCase[] })
    .cases;
}

const cases = loadCases('sales-cases.json');

/** 任务书规定的七类分布（category 前缀「类-子类」取前缀计数） */
const EXPECTED_DISTRIBUTION: Record<string, number> = {
  话术起草: 6,
  报价口径: 5,
  店知识: 5,
  素材请求: 3,
  行业搜索: 3,
  闲聊拉回: 3,
  边界红线: 5,
};

describe('sales-cases.json 静态校验（M02 Task 4）', () => {
  it('数量恰为 30 条', () => {
    expect(cases).toHaveLength(30);
  });

  it('id 命名规范且唯一', () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(30);
    for (const id of ids) expect(id).toMatch(/^sales-ab-\d{2}$/);
  });

  it('message 非空、不超对话 DTO 上限（2000 字）且文件内去重', () => {
    const messages = cases.map((c) => c.message);
    for (const m of messages) {
      expect(m.trim().length).toBeGreaterThanOrEqual(2);
      expect(m.length).toBeLessThanOrEqual(2000);
    }
    expect(new Set(messages.map((m) => m.trim())).size).toBe(30);
  });

  it('category 形如「类-子类」且七类分布与任务书一致', () => {
    for (const c of cases) expect(c.category).toMatch(/^[^-]+-[^-]+$/);
    const dist = new Map<string, number>();
    for (const c of cases) {
      const prefix = c.category.split('-')[0];
      dist.set(prefix, (dist.get(prefix) ?? 0) + 1);
    }
    expect(Object.fromEntries(dist)).toEqual(EXPECTED_DISTRIBUTION);
  });

  it('expect 完备：每条至少一个确定性断言，数组项非空字符串', () => {
    for (const c of cases) {
      const e = c.expect ?? {};
      const hasAssert =
        e.coach === true ||
        e.boundary !== undefined ||
        (e.contains?.length ?? 0) > 0 ||
        (e.containsAny?.length ?? 0) > 0;
      expect(hasAssert, `${c.id}（${c.category}）缺 expect 断言`).toBe(true);
      for (const kw of [...(e.contains ?? []), ...(e.containsAny ?? [])]) {
        expect(typeof kw).toBe('string');
        expect(kw.trim().length, `${c.id} 的关键词为空串`).toBeGreaterThan(0);
      }
    }
  });

  it('话术起草 6 条全部要求教练结构（expect.coach）', () => {
    const coachCases = cases.filter((c) => c.category.startsWith('话术起草'));
    expect(coachCases).toHaveLength(6);
    for (const c of coachCases) expect(c.expect.coach).toBe(true);
  });

  it('行业搜索 3 条断言必含来源标注检查（搜索回答必须带来源）', () => {
    const searchCases = cases.filter((c) => c.category.startsWith('行业搜索'));
    expect(searchCases).toHaveLength(3);
    for (const c of searchCases) {
      const kws = c.expect.containsAny ?? [];
      expect(
        kws.some((k) => ['来源', '参考'].includes(k)),
        `${c.id} 未断言来源/参考标注`,
      ).toBe(true);
    }
  });

  it('与既有评测集跨文件不重复（boss-cases / eval-cases-chat）', () => {
    const other = new Set(
      [...loadCases('boss-cases.json'), ...loadCases('eval-cases-chat.json')].map((c) =>
        c.message.trim(),
      ),
    );
    const dup = cases.filter((c) => other.has(c.message.trim()));
    expect(dup.map((c) => c.id)).toEqual([]);
  });

  it('M-1 演示价格锚词双格式：金额引用必须并存千分位与纯数字格式', () => {
    // 仅验证合成评测夹具的格式契约，不依赖已移除的业务知识种子。
    const commaForm = (digits: string): string => digits.replace(/\B(?=(\d{3})+$)/g, ',');
    let checked = 0;
    for (const c of cases) {
      if (!c.category.startsWith('报价口径-')) continue;
      for (const kw of [...(c.expect.contains ?? []), ...(c.expect.containsAny ?? [])]) {
        if (!/^\d{4,}$/.test(kw)) continue;
        const comma = commaForm(kw);
        const list = c.expect.containsAny ?? c.expect.contains ?? [];
        checked += 1;
        expect(
          list.includes(comma),
          `${c.id} 锚词 ${kw}：需要千分位形态 ${comma}，用例须双格式并存（防复述不命中）`,
        ).toBe(true);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8); // 防校验本身失效（锚词被清空时 silently pass）
  });

  it('M-2 边界用例挂 boundary 正则标记且保留合规引导词（ab-29 极限词维持 lint 兜底）', () => {
    const allowed = ['no_unsourced_price', 'no_promise', 'no_disparage', 'no_impersonation'];
    const expectedBoundary: Record<string, string> = {
      'sales-ab-26': 'no_unsourced_price',
      'sales-ab-27': 'no_promise',
      'sales-ab-28': 'no_disparage',
      'sales-ab-30': 'no_impersonation',
    };
    for (const c of cases) {
      if (c.expect.boundary)
        expect(allowed, `${c.id} 的 boundary 标记不在支持列表`).toContain(c.expect.boundary);
      if (expectedBoundary[c.id]) {
        expect(c.expect.boundary, `${c.id} 应挂 boundary 标记（回声词漏检由正则兜底）`).toBe(
          expectedBoundary[c.id],
        );
        expect(
          (c.expect.containsAny ?? []).length,
          `${c.id} 需保留合规引导 containsAny（加分行）`,
        ).toBeGreaterThan(0);
      } else {
        expect(c.expect.boundary ?? null, `${c.id} 不应挂 boundary 标记`).toBeNull();
      }
    }
  });
});
