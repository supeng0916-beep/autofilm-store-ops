---
name: skill-competitor-notes
description: "AutoFilm Demo 同行信息整理：把人工浏览并粘贴的同行公开内容（评论区/主页/活动页）提炼为结构化要点（价格/活动/卖点/渠道）。只提炼粘贴文本中的事实，不推测、不补充外部信息、不评价好坏。结果进知识库草稿，人工审核后生效。"
user-invocable: false
---

# skill-competitor-notes（同行信息整理）

把**人工浏览公开内容后粘贴的文本**提炼为结构化要点，供店内参考。合规口径（项目方 2026-08-18 确认）：平台官方 API + 人工浏览公开内容 + AI 辅助整理；**不做**任何自动化抓取。本技能只处理用户主动粘贴的文本。

## 核心原则（硬边界）

1. **只提炼 sourceText 中存在的事实**——不推测、不脑补、不使用模型记忆里的行业信息
2. **不做评价**——不判断同行好坏优劣，只客观归纳
3. **区分不确定**——原文模糊/存疑的内容放进 caution 说明，不硬归入要点
4. 输出为知识库草稿素材，需人工审核后生效

## 输入

`message` 是 JSON 字符串：

```json
{
  "taskId": "…",
  "taskType": "marketing.competitor_notes",
  "context": {
    "sourceText": "（人工浏览粘贴的同行公开内容全文）",
    "sourcePlatform": "抖音"
  },
  "constraints": { "boundary": "…" }
}
```

## 输出纪律（最高优先级）

- 思考过程一律在内部完成，**最终回复必须且只能是一个 JSON 对象**（按下方模板），不得包裹在 `text` 字段、markdown 代码块或任何叙述性文字里
- 成稿内容必须**完整写进对应字段**（如 script/points）——禁止以"已写入草稿""草稿如下（见附件）"等描述代替实际内容
- 所有字段同时给出（数组可为空），字段名用英文、按模板拼写

## 输出（严格 JSON，无其他文本）

```json
{
  "summary": "一段话客观摘要（≤120 字）",
  "points": [
    { "kind": "price", "content": "车衣套餐标价 3999 起（评论区截图所述）" },
    { "kind": "activity", "content": "…6 月到店赠送脚垫（主页活动页）" },
    { "kind": "selling_point", "content": "…宣传'进口顶级膜'（原文表述，未证实）" }
  ],
  "caution": "原文中模糊/广告性表述的提示，无则 null"
}
```

kind 取值限定：`price`（价格）/ `activity`（活动）/ `selling_point`（卖点宣传）/ `channel`（获客渠道）/ `other`。points 可为空数组；content 忠实转述原文（宣传性表述注明"原文表述"）。
