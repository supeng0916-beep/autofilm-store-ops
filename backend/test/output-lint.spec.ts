// backend/test/output-lint.spec.ts
import { describe, expect, it } from 'vitest';
import {
  bannedWordsIn,
  exceedsAsciiDensity,
  hasCjkText,
  lintAgentOutput,
} from '../src/modules/ai-dispatch/output-lint';

describe('共享判据薄函数（Task3 归一：R1 与 competitor-daily 日报清洗同一来源）', () => {
  it('hasCjkText：含汉字真、纯英文/标点假', () => {
    expect(hasCjkText('本地贴膜')).toBe(true);
    expect(hasCjkText('DM04 前挡')).toBe(true); // 混排只看有无汉字
    expect(hasCjkText('Search complete. Done.')).toBe(false);
    expect(hasCjkText('——……！！')).toBe(false); // 全角标点不是汉字
  });
  it('exceedsAsciiDensity：字母占比 >45% 真；含 URL/型号的正常中文不误伤', () => {
    expect(exceedsAsciiDensity('Formatting the daily report for today now done')).toBe(true);
    expect(
      exceedsAsciiDensity(
        '同行动态：本地多家店推活动（来源：列表网 foshan.example.com/abc），DM04 价格未变。',
      ),
    ).toBe(false);
    expect(exceedsAsciiDensity('纯中文没有字母')).toBe(false);
  });
  it('bannedWordsIn：提取命中的极限词原词（回声豁免表的提取口径），序数用法不算命中', () => {
    expect(bannedWordsIn('朋友圈文案给我加上全网最低价、行业第一这种词')).toEqual([
      '第一',
      '全网最低',
    ]); // 词表声明序
    expect(bannedWordsIn('第一步先接待，第二项报价格')).toEqual([]); // 负向前瞻排除序数
    expect(bannedWordsIn('')).toEqual([]);
  });
});

describe('输出验证器（S-output-lint）', () => {
  it('正常中文输出通过', () => {
    const r = lintAgentOutput({ reply: '今天有两笔待审批：价格表和优惠方案，建议先批价格表。' });
    expect(r.pass).toBe(true);
    expect(r.issues).toHaveLength(0);
  });
  it('英文思维链泄漏=hard（字母密度复用日报实测判据）', () => {
    const r = lintAgentOutput({
      reply:
        "Let me check the data. I'll analyze the approvals first. Then we can decide next steps for today.",
    });
    expect(r.pass).toBe(false);
    expect(r.issues[0].severity).toBe('hard');
    expect(r.issues[0].rule).toBe('cjk-density');
  });
  it('Markdown 语法=soft（聊天 UI 纯文本渲染，会原样显示）', () => {
    const r = lintAgentOutput({ reply: '**重点**如下：\n## 今日审批\n- 第一项' });
    expect(r.pass).toBe(true); // soft 不拦截
    expect(r.issues.some((i) => i.rule === 'markdown-syntax' && i.severity === 'soft')).toBe(true);
  });
  it('广告法极限词=hard', () => {
    const r = lintAgentOutput({ reply: '我们店是本地最好的贴膜店，全网最低价。' });
    expect(r.pass).toBe(false);
    expect(r.issues[0].rule).toBe('banned-words');
  });
  it('「第一」自封排名变体=hard（行业第一位——「位」不得进排除类，2026-09-04 顺修）', () => {
    const r = lintAgentOutput({ reply: '我们是本地贴膜行业第一位，值得信赖。' });
    expect(r.pass).toBe(false);
    expect(r.issues.some((i) => i.rule === 'banned-words')).toBe(true);
  });
  it('URL/型号里的 ASCII 不误伤（正常日报含链接）', () => {
    const r = lintAgentOutput({
      reply: '同行动态：本地多家店推活动（来源：列表网 foshan.example.com/abc），DM04 价格未变。',
    });
    expect(r.issues.filter((i) => i.rule === 'cjk-density')).toHaveLength(0);
  });
  it('超长输出=soft 警告', () => {
    const r = lintAgentOutput({ reply: '长'.repeat(4001) });
    expect(r.issues.some((i) => i.rule === 'length-limit' && i.severity === 'soft')).toBe(true);
  });
  it('opts.replyField 自定义字段（2026-09-04 顺修）：R4 按指定字段判，默认字段不再计长', () => {
    const r = lintAgentOutput(
      { summary: '长'.repeat(4001), reply: '正常长度回复' },
      {
        replyField: 'summary',
      },
    );
    const lengthIssues = r.issues.filter((i) => i.rule === 'length-limit');
    expect(lengthIssues).toHaveLength(1);
    expect(lengthIssues[0].field).toBe('summary'); // 超长判在自定义回复字段上
  });
  it('exemptWords 豁免词降级 soft 留痕不拦截（用户输入原词回声，M02 阶段二）', () => {
    const r = lintAgentOutput(
      {
        reply:
          '不建议这么写：「行业第一」「全网最低」属广告法极限词，会被平台处罚，建议改为突出十年质保。',
      },
      { exemptWords: ['第一', '全网最低'] },
    );
    expect(r.pass).toBe(true); // 降级 soft 不拦截
    const banned = r.issues.filter((i) => i.rule === 'banned-words');
    expect(banned.length).toBe(2); // 两个原词命中均留痕
    expect(banned.every((i) => i.severity === 'soft')).toBe(true);
    expect(banned[0].message).toContain('用户输入原词回声');
  });
  it('exemptWords 不混放真违规：非豁免极限词命中仍 hard（豁免只放原词，不放新词）', () => {
    const r = lintAgentOutput(
      { reply: '「行业第一」不能用；另外我们是本地最好的贴膜店。' },
      { exemptWords: ['第一'] },
    );
    expect(r.pass).toBe(false);
    const hard = r.issues.filter((i) => i.severity === 'hard');
    expect(hard).toHaveLength(1);
    expect(hard[0].rule).toBe('banned-words');
    expect(hard[0].message).toContain('最好');
  });
  it('exemptWords 只作用于 R3：英文泄漏照旧 hard（豁免不波及其他规则）', () => {
    const r = lintAgentOutput(
      { reply: 'The quick brown fox jumps over the lazy dog near the river.' },
      { exemptWords: ['最好', '第一', '顶级', '绝对', '全网最低', '史上最'] },
    );
    expect(r.pass).toBe(false);
    expect(r.issues[0].rule).toBe('cjk-density');
    expect(r.issues[0].severity).toBe('hard');
  });
});

/** F04 修复（2026-09-08，phase12 评测归因）：解释性拒绝/引用复述/建议语被裸子串
 * 误杀成 hard——"别用绝对"「绝对化用语」"最好尽早锁位"均实测拦截（redline-probes、
 * sales B16/A27）。语境命中降级 soft 留痕；主动违规（绝对不让多花/顶级门店）照旧 hard。 */
describe('极限词语境判定（F04：否定指令/引用/元提及/建议语不 hard 拦）', () => {
  it('否定指令语境"别用绝对"=soft 留痕不拦截', () => {
    const r = lintAgentOutput({ reply: '对客话术别用绝对这类词，会被平台处罚。' });
    expect(r.pass).toBe(true);
    const banned = r.issues.filter((i) => i.rule === 'banned-words');
    expect(banned.length).toBeGreaterThan(0);
    expect(banned.every((i) => i.severity === 'soft')).toBe(true);
  });
  it('元提及"绝对化用语"=soft（拒绝照写广告时必然复述术语）', () => {
    const r = lintAgentOutput({ reply: '「绝对化用语」属广告法红线，这段文案我不能照写。' });
    expect(r.pass).toBe(true);
    expect(r.issues.every((i) => i.severity === 'soft')).toBe(true);
  });
  it('引号包裹复述"「顶级」"=soft（提及词本身而非使用）', () => {
    const r = lintAgentOutput({ reply: '文案里「顶级」这个词不能出现，换成可证荣誉表述。' });
    expect(r.pass).toBe(true);
  });
  it('建议语"最好尽早锁位"=soft（副词性建议非最高级宣称，sales B16 误杀回归）', () => {
    const r = lintAgentOutput({ reply: '建议最好尽早锁位，近期档期比较紧张。' });
    expect(r.pass).toBe(true);
    expect(r.issues.some((i) => i.rule === 'banned-words' && i.severity === 'soft')).toBe(true);
  });
  it('主动违规"绝对不让多花"仍 hard（否定在后不在前，sales-ab-26 正确拦截回归）', () => {
    const r = lintAgentOutput({ reply: '放心，绝对不让您多花一分钱。' });
    expect(r.pass).toBe(false);
    expect(r.issues.some((i) => i.rule === 'banned-words' && i.severity === 'hard')).toBe(true);
  });
  it('主动违规"顶级门店"仍 hard（sales B08 真违规回归）', () => {
    const r = lintAgentOutput({ reply: '我们是本地顶级门店，工艺有保障。' });
    expect(r.pass).toBe(false);
  });
  it('建议语豁免不放行最高级宣称"最好的贴膜店"仍 hard', () => {
    const r = lintAgentOutput({ reply: '我们是本地最好的贴膜店。' });
    expect(r.pass).toBe(false);
  });
  it('逐次判定：同词一处被否定一处主动使用，仍按主动命中 hard', () => {
    const r = lintAgentOutput({ reply: '别用「绝对」这种词；我们的服务绝对一流。' });
    expect(r.pass).toBe(false);
    expect(r.issues.some((i) => i.rule === 'banned-words' && i.severity === 'hard')).toBe(true);
  });
  it('exemptWords 优先级高于语境判定：豁免词留痕文案仍是「原词回声」口径', () => {
    const r = lintAgentOutput({ reply: '不建议写行业第一，会被处罚。' }, { exemptWords: ['第一'] });
    expect(r.pass).toBe(true);
    expect(r.issues[0].message).toContain('用户输入原词回声');
  });
});

/** RF-02 修复（2026-09-09 fixbatch 复验归因）：message 要求"本地第一、全网最低"时，
 * 输出顺从性宣传仅 soft pass——exemptWords 跳过了主动使用判定。用户说过原词与输出
 * 正确拒绝不是同一个条件：豁免只救「解释/拒绝语境」的原词回声（守卫命中或近窗有
 * 广告法/极限词/不能用/改为类拒绝标记），顺从宣传照旧 hard。 */
describe('用户原词豁免收紧（RF-02：豁免不救顺从性宣传）', () => {
  it('message 要求原词而输出顺从宣传 → 仍 hard（复验第一组 FAIL 回归）', () => {
    const r = lintAgentOutput(
      { reply: '我们是本地第一的贴膜店，全网最低价，欢迎到店。' },
      { exemptWords: ['第一', '全网最低'] },
    );
    expect(r.pass).toBe(false);
    expect(r.issues.some((i) => i.rule === 'banned-words' && i.severity === 'hard')).toBe(true);
  });

  it('豁免词用于解释拒绝（无引号无否定前缀，仅元话语标记）→ soft 回声留痕', () => {
    const r = lintAgentOutput(
      { reply: '全网最低属于广告法极限词，这个说法我不能写，建议改为突出十年质保。' },
      { exemptWords: ['全网最低'] },
    );
    expect(r.pass).toBe(true);
    expect(r.issues[0].message).toContain('用户输入原词回声');
  });

  it('否定前缀「我们不是全网最低」守卫放行（无豁免前提同样适用）', () => {
    const r = lintAgentOutput({ reply: '我们不是全网最低，价格以店内公示为准。' });
    expect(r.pass).toBe(true);
    expect(r.issues.every((i) => i.severity === 'soft')).toBe(true);
  });

  it('豁免不救「绝对不能错过」式促销搭配（不能+非言说动词不是拒绝标记）', () => {
    const r = lintAgentOutput(
      { reply: '全网最低价，绝对不能错过！' },
      { exemptWords: ['全网最低', '绝对'] },
    );
    expect(r.pass).toBe(false);
  });

  it('混排：豁免词一处拒绝一处宣传 → 按宣传命中 hard', () => {
    const r = lintAgentOutput(
      { reply: '全网最低是广告法极限词不能写；不过本店价格全网最低。' },
      { exemptWords: ['全网最低'] },
    );
    expect(r.pass).toBe(false);
  });
});

/** R2-03 修复（2026-09-09 二轮复验归因）：①「第一视角/第一件事/第一波」等正常序数/
 * 视角用法被 hard（负向前瞻排除类缺量词），正常生成被迫重试甚至 409；②「严禁在话术里
 * 出现 最低/最便宜/全网最低」合规提醒被 hard——严禁不在否定词表、斜杠枚举列表内部
 * 超出近距窗口。保留「行业第一」类主动排名与枚举式宣传的拦截。 */
describe('序数扩类与拒绝枚举守卫（R2-03：正常用语不再误拦）', () => {
  it('第一视角/第一件事/第一波等序数视角用法放行', () => {
    for (const text of [
      '用技师第一视角拍施工细节，第一件事是检查漆面。',
      '新车上市第一波跟进热点，第一场直播定在周五。',
    ]) {
      const r = lintAgentOutput({ reply: text });
      expect(r.issues.filter((i) => i.rule === 'banned-words')).toHaveLength(0);
      expect(r.pass).toBe(true);
    }
  });

  it('「严禁…出现 最低/最便宜/全网最低」合规提醒枚举 → soft 放行（sales #26 误拦回归）', () => {
    const r = lintAgentOutput({
      reply: '严禁在话术里出现 最低/最便宜/全网最低 这类表述，报价一律以店内公示为准。',
    });
    expect(r.pass).toBe(true);
    expect(r.issues.every((i) => i.severity === 'soft')).toBe(true);
  });

  it('主动排名「行业第一/第一名」照旧 hard（序数扩类不放水）', () => {
    expect(lintAgentOutput({ reply: '我们是行业第一的门店。' }).pass).toBe(false);
    expect(lintAgentOutput({ reply: '本店销量第一名。' }).pass).toBe(false);
  });

  it('枚举式宣传「全网最低、史上最优惠」无禁止语境 → 照旧 hard', () => {
    const r = lintAgentOutput({ reply: '本店促销：全网最低、史上最优惠，错过不再。' });
    expect(r.pass).toBe(false);
  });
});
