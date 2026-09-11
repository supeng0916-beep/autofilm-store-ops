---
name: skill-lead-summary
description: "AutoFilm Demo 客资摘要：依据脱敏后的客资上下文（车型/需求/来源/阶段/最近跟进）生成建议态摘要，输出严格 JSON（summary/concerns/questionsToAsk/nextAction/visitPitch/escalationHint），不臆造身份、不报价、不使用任何工具。"
user-invocable: false
---

# skill-lead-summary（客户摘要）

本技能为门店销售生成一份**客户情况摘要**，供一线销售在跟单前快速了解客户意图、关注点与下一步动作。输出为**建议态**，只进入后端 `ai_tasks.output`，绝不写任何业务字段，也不触发任何对外动作。

## 输入

`message` 是一个 JSON 字符串（后端 ai-dispatch 经 Gateway 提交的载荷）：

```json
{
  "taskId": "…",
  "taskType": "lead.summary",
  "context": {
    "refId": "ref_…",
    "sourcePlatform": "抖音",
    "businessType": "auto_film",
    "target": "特斯拉 Model Y",
    "productNeed": "改色膜",
    "rawNeed": "想贴改色膜，预算 6000 左右，最好这个月内",
    "stage": "new",
    "lastFollowUpResult": null
  },
  "constraints": {
    "boundary": "仅依据给定客资上下文摘要，不臆造身份，不报价，输出为建议态"
  }
}
```

- `context.refId`：客户假名 ID（脱敏后标识，**不是**真实姓名/手机/微信）。
- `context.sourcePlatform`：来源渠道（抖音/4S店/老客户转介绍/小红书/视频号/到店等）。
- `context.businessType`：业务类型 `auto_film`（车膜）或 `home_film`（住宅膜）。
- `context.target`：车型或住宅对象；`productNeed` 为客户明确询问的产品；`rawNeed` 为客户原始需求原话。
- `context.stage`：当前阶段；`context.lastFollowUpResult`：最近一次跟进结果（可为 null）。
- `constraints.boundary`：任务级行为边界，**必须遵守**。

## 输出（严格 JSON）

只输出一个 JSON 对象，**不得**用 Markdown 代码块包裹、**不得**附带任何解释文字或多余字段：

```json
{
  "summary": "客户通过抖音咨询特斯拉 Model Y 改色膜，预算约 6000，希望本月内完成，意向明确。",
  "concerns": ["价格预算", "施工工期"],
  "questionsToAsk": ["是否已确定具体颜色？", "是否方便本周到店看色卡？"],
  "nextAction": "联系客户确认颜色偏好，预约到店看膜",
  "visitPitch": "到店可实地看膜片与实车效果，30 分钟出方案",
  "escalationHint": "若两天内未回复，建议店长介入跟进"
}
```

字段契约（后端用 `LeadSummaryOutputSchema` 校验，`summary`/`nextAction` 缺失或空串会判输出无效并降级）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `summary` | 是 | 客户情况摘要（非空字符串） |
| `concerns` | 否 | 关注点列表（缺省 `[]`） |
| `questionsToAsk` | 否 | 建议向客户确认的问题（缺省 `[]`） |
| `nextAction` | 是 | 建议下一动作（非空字符串） |
| `visitPitch` | 否 | 到店理由 |
| `escalationHint` | 否 | 升级时机建议（如「连续 N 天未回复→店长介入」） |

## 约束（硬性）

- **只依据给定 `context` 摘要**，不得臆造客户的姓名、联系方式、车型、需求或任何上下文之外的事实。
- **主语归属必须准确（2026-08-27 复评修订）**：跟进记录中「老板/销售/门店」的动作（发送报价单、给出优惠、承诺同行结算价、展示案例）与「客户」的动作（询问、砍价、确认提车）严格区分，**不得把门店动作写成客户动作**（如「客户发送了报价单」是严重错误——发报价单的是老板）。无法确定主语时按上下文时间线保守表述（如「门店已发送报价单」）。
- **直接输出严格 JSON**：第一个字符就是 `{`，不得有任何过程性叙述、英文独白（如 "I'll read the skill file…"）或 Markdown 围栏。
- **不报价、不承诺**：不得给出具体金额、优惠、质保、工期或赠品承诺；涉及价格话题一律写「引导到店 / 转人工报价」。
- **建议态措辞**：所有输出是给销售参考的建议，用「建议 / 可考虑 / 建议确认」等措辞，不做确定性判定（如「客户一定会成交」）。
- **不使用任何工具**（biz-query / knowledge-search 白名单本阶段均不启用），不访问客户数据、不读取凭证、不发起网络请求。
- 只做「读取输入 → 生成摘要 → 输出严格 JSON」，不执行任何对外动作。

## 示例

**示例 1：高意向（车膜）**

输入 `context`：`{ "refId": "ref_1", "sourcePlatform": "4S店", "businessType": "auto_film", "target": "理想 L9", "productNeed": "全车隐形车衣", "rawNeed": "4S 店介绍的，想贴全车车衣，预算 15000，随时可到店", "stage": "new", "lastFollowUpResult": null }`

输出：

```json
{
  "summary": "4S 店介绍客户，理想 L9 想贴全车隐形车衣，预算约 15000，随时可到店，意向强。",
  "concerns": ["车衣品牌与质保", "施工周期"],
  "questionsToAsk": ["是否已确定车衣品牌？", "希望约哪个时间段到店？"],
  "nextAction": "联系客户确认车衣品牌偏好并预约到店",
  "visitPitch": "到店可对比多品牌车衣样板与实车案例",
  "escalationHint": "客户随时可到店，建议今日内联系，避免流失"
}
```

**示例 2：低意向（住宅膜）**

输入 `context`：`{ "refId": "ref_2", "sourcePlatform": "小红书", "businessType": "home_film", "target": "住宅客厅玻璃", "productNeed": "隔热膜", "rawNeed": "随便看看玻璃隔热膜价格", "stage": "new", "lastFollowUpResult": null }`

输出：

```json
{
  "summary": "客户经小红书咨询住宅客厅玻璃隔热膜，当前仅了解价格，意向偏低。",
  "concerns": ["价格", "效果"],
  "questionsToAsk": ["住宅朝向与玻璃面积？", "主要想解决隔热还是隐私？"],
  "nextAction": "简单介绍住宅膜优势，了解客户核心诉求后再跟进",
  "visitPitch": "可到店看住宅膜样板，现场测隔热效果",
  "escalationHint": "低意向客户，无需强推，记录偏好后保持低频跟进"
}
```
