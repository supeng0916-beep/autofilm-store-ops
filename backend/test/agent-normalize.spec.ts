import { describe, expect, it } from 'vitest';

import {
  cleanReplyText,
  normalizeSalesAgentOutput,
  postLintBossAgentOutput,
} from '../src/modules/agent/agent.service';

/** 回复确定性清洗单测（2026-08-27 复评：格式混乱治本）——markdown/独白/emoji 三类必清，
 * 编号（①②③）与中文标点必须保留。 */
describe('cleanReplyText / normalizeSalesAgentOutput 格式清洗', () => {
  it('通用英文前置段剥离（全流程测试 #3："Looking at the knowledge context…" 整行起手）', () => {
    const out = cleanReplyText(
      "Looking at the knowledge context for DM04 and DM13 — these are two different windows' films in the same combo, not competing products.\n结论：DM04 是前挡主力，DM13 是侧后挡入门。\n\n——\n哥，窗膜给您这么选…",
    );
    expect(out).not.toContain('Looking at');
    expect(out.startsWith('结论')).toBe(true);
    expect(out).toContain('DM04 是前挡主力');
  });

  it('行内混排：英文思考句后紧跟中文 → 剥英文保留中文', () => {
    const out = cleanReplyText(
      'The employee is asking about warranty policy. 质保按型号分 5~12 年。',
    );
    expect(out).not.toContain('The employee');
    expect(out).toContain('质保按型号分');
  });

  it('纯中文回复与含型号代码的行不受误伤（回归）', () => {
    const out = cleanReplyText('DM04 是前挡专用，7.5mil 是演示款和演示品牌乙的厚度。');
    expect(out).toContain('DM04 是前挡专用');
    expect(out).toContain('7.5mil');
  });

  it('剥前导英文独白（o8-04 同款 "I\'ll read the skill file…"）', () => {
    const out = cleanReplyText(
      "I'll read the skill file first as required.\nDM04 是前挡主力，DM13 是侧后挡入门款。",
    );
    expect(out).not.toContain("I'll");
    expect(out).toContain('DM04 是前挡主力');
  });

  it('markdown 表格 → 全角管道符 + 丢分隔行（保结构可读）', () => {
    const md = ['| 型号 | 质保 |', '|---|---|', '| DM03 | 12年 |', '| DM12 | 10年 |'].join('\n');
    const out = cleanReplyText(md);
    expect(out).not.toMatch(/\|/); // 无半角管道符残留
    expect(out).not.toContain('---'); // 分隔行已丢
    expect(out).toContain('型号 ｜ 质保'); // 边缘管道符清理，列间用全角｜
    expect(out).toContain('DM03');
    expect(out).toContain('12年');
  });

  it('星号加粗/井号标题/反引号/分隔线 → 纯文本', () => {
    const md = '## 报价口径\n**DM04** 是 `前挡专用`，别讲错。\n---\n结尾。';
    const out = cleanReplyText(md);
    expect(out).not.toContain('**');
    expect(out).not.toMatch(/^#/m);
    expect(out).not.toContain('`');
    expect(out).not.toContain('---'); // 分隔线行整行清除
    expect(out).toContain('报价口径');
    expect(out).toContain('DM04 是 前挡专用');
    expect(out).toContain('结尾');
  });

  it('剥 emoji，保留 ①②③ 与中文标点', () => {
    const out = cleanReplyText('⚠️ 注意：① 授权店购买 ② 原厂漆施工 ✅');
    expect(out).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(out).toContain('①');
    expect(out).toContain('②');
    expect(out).toContain('注意');
  });

  it('normalize：字符串独白+正文 → 清洗后 reply；对象 reply 字段同样清洗', () => {
    const a = normalizeSalesAgentOutput('I will check the context first. 质保要满足三个前提。') as {
      reply: string;
    };
    expect(a.reply).not.toContain('I will');
    expect(a.reply).toContain('质保要满足三个前提');

    const b = normalizeSalesAgentOutput({
      reply: '**结论**：DM04 前挡首选 ⭐',
      suggestions: ['帮我看下 DM13 和 DM14 差异 🚗'],
    }) as { reply: string; suggestions: string[] };
    expect(b.reply).not.toContain('**');
    expect(b.reply).toContain('结论');
    expect(b.suggestions[0]).not.toContain('🚗');
  });
});

/** F06 修复（2026-09-08 phase12 评测归因）：done 并不代表可用正文——boss B04 整段英文
 * 执行过程落库为 done（boss/manager 未挂 postLint）、sales A08/红线29 返回未解析 JSON。
 * 修复分两层：JSON 残渣在归一层救援/降级；英文过程泄漏走 postLint R1（boss/manager
 * 渐进接入 postLintBossAgentOutput，终态 failed「lint 拦截」与 sales 同口径可重试）。 */
describe('normalize JSON 救援 + boss 通道 R1 验证（F06：过程文本/JSON 残渣不成稿）', () => {
  it('未解析 JSON：坏 JSON 中可救回完整契约字段值（救成 done 优于整单降级）', () => {
    const out = normalizeSalesAgentOutput(
      '{"reply": "今日排期为空，建议人工确认。", "suggestions": [broken',
    ) as { reply: string };
    expect(out.reply).toBe('今日排期为空，建议人工确认。');
  });

  it('未解析 JSON：救不回契约字段 → 空 reply（JSON 残渣永远不是成稿）', () => {
    const out = normalizeSalesAgentOutput('{process: 执行过程, tools: [call(') as {
      reply: string;
    };
    expect(out.reply).toBe('');
  });

  it('正文混排 JSON 契约残渣（不以 { 起手）同样按字段救回', () => {
    const out = normalizeSalesAgentOutput(
      '执行过程：先查排期再查工单。\n"reply": "今日排期为空，建议人工确认。"',
    ) as { reply: string };
    expect(out.reply).toBe('今日排期为空，建议人工确认。');
  });

  it('正常中文正文不受救援路径影响（回归）', () => {
    const out = normalizeSalesAgentOutput('今日排期为空，建议人工确认。') as { reply: string };
    expect(out.reply).toBe('今日排期为空，建议人工确认。');
  });

  it('中文为主混排型号/短英文不误伤（回归）', () => {
    const out = normalizeSalesAgentOutput('DM04 前挡专用，DM13 是侧后挡入门款，7.5mil 厚度。') as {
      reply: string;
    };
    expect(out.reply).toContain('DM04 前挡专用');
  });

  it('postLintBossAgentOutput：整段英文过程文本 hard 拦（boss B04 回归）', () => {
    const r = postLintBossAgentOutput({
      reply:
        "Looking at the store data, I can see that today's schedule is completely empty. Let me summarize the findings for the boss.",
    });
    expect(r.pass).toBe(false);
    expect(r.issues.some((i) => i.rule === 'cjk-density' && i.severity === 'hard')).toBe(true);
  });

  it('postLintBossAgentOutput：reasoning 英文泄漏同拦；中文正常输出通过', () => {
    expect(
      postLintBossAgentOutput({ reply: '今日排期为空。', reasoning: 'Let me check the data.' })
        .pass,
    ).toBe(false);
    expect(
      postLintBossAgentOutput({
        reply: '今日排期为空，建议人工确认。',
        reasoning: '依据总览计数。',
      }).pass,
    ).toBe(true);
  });

  it('postLintBossAgentOutput：内部分析含极限词不拦（R3 面向对客成稿，boss 通道只拦 R1）', () => {
    const r = postLintBossAgentOutput({ reply: '本月最好的技师是周师傅，绝对主力。' });
    expect(r.pass).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it('P3-F02：reasoning 超长按句边界截断，不产「以门店」式残句', () => {
    const long = '综合门店排期与技师负载考虑。'.repeat(15); // 210 字，句读每 14 字
    const out = normalizeSalesAgentOutput({ reply: '今日排期为空。', reasoning: long }) as {
      reasoning: string;
    };
    expect(out.reasoning.length).toBeLessThanOrEqual(200);
    expect(out.reasoning.endsWith('。')).toBe(true); // 截在句读处（196 字）
    expect(out.reasoning).toBe('综合门店排期与技师负载考虑。'.repeat(14));
  });
});
