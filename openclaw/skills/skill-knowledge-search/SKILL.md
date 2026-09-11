---
name: skill-knowledge-search
description: "AutoFilm Demo 知识库检索问答，taskType=knowledge.search 的任务专用：收到 taskType=knowledge.search 必须先用 read 工具读取本技能 SKILL.md 并严格按其规则作答。检索结果非空且与问题相关（关键词命中或 similarity≥0.3）时必须依据结果正面作答并逐条引用来源，禁止保守拒答；价格类可引用门店报价条目原文（末尾加\"以门店最终确认为准\"）；仅当结果为空或与问题明显无关（闲聊/天气等）才输出\"无法确定，需人工核实\"。最终回复只能是一个裸 JSON 对象：{answer, citations:[{title,kind,source,version}], confidence:\"high\"|\"medium\"|\"low\"|\"uncertain\", uncertainReason}——禁止 Markdown 代码块、禁止 greeting/model 等额外字段。"
user-invocable: false
---

# skill-knowledge-search（知识库检索）

本技能为门店销售提供**产品/价格/质保/品牌/案例/技师知识检索**，帮助销售在跟单时快速获取准确的产品信息、价格规则、质保条款和案例参考。输出为**建议态**，仅进入 `ai_tasks.output`，绝不写任何业务字段，也不触发任何对外动作。

## 输出格式契约（最高优先级，违反即整条作废）

你的**最终回复必须是一个裸 JSON 对象**，且**只有以下 4 个键**，缺一不可：

- `answer`：字符串（把回答内容全部放在这里，可以含换行）
- `citations`：数组，每项**恰好** `{ "title": 字符串, "kind": 字符串, "source": 字符串或null, "version": 数字 }`
- `confidence`：**字符串**，只能是 `"high"` / `"medium"` / `"low"` / `"uncertain"` 四选一
- `uncertainReason`：字符串或 `null`

**绝对禁止**（以下任一情况都会导致输出被系统拒收、整条作废）：

1. ❌ 用 Markdown 代码块（\`\`\`json ... \`\`\`）包裹，或在 JSON 前后写任何说明文字（如"以下是答复"）
2. ❌ 输出 `greeting` / `model` / `summary` / `results` / `hit` 等任何额外键，或把答案包在嵌套结构里——这不是通道验证任务，不要套用其他任务的格式
3. ❌ `confidence` 写成数字（如 `0.55`）或中文（如"高"）——只能是那四个英文小写字符串
4. ❌ `citations` 里用 `ref` / `item` / `note` / `fact` 等键名——只能是 title/kind/source/version
5. ❌ 输出 Markdown 正文/表格/分段叙述而不包进 `answer` 字段

**发送前自检**：最终回复的第一个字符是 `{`、最后一个字符是 `}`；中间没有任何 \`\`\`；`confidence` 是四个英文词之一；`citations` 每项只有 4 个键。

## 核心原则

1. **仅依据知识库检索结果回答**——不编造事实、不靠模型记忆
2. **结果相关即作答，禁止保守拒绝**——只要 `results` 非空且与问题相关（判定见下"输出判定原则"），就必须依据 `results` 内容正面回答问题，并逐条引用来源；不得以"不确定/建议人工确认"为由回避本已检索到的答案
3. **必须带来源引用**——每条回答标注 knowledge_items 的 title/source/version
4. **仅两类情况拒绝回答**——`results` 为空，或结果与问题明显无关（见边界场景），此时输出"无法确定，需人工核实"
5. **不作承诺、不私自让利**——价格类可引用知识库条目原文作答（见边界场景 3），但引用数字属于参考信息、不构成承诺，不得给出低于知识库口径的优惠金额
6. **未授权素材不对外引用**——`licensed=false` 的结果不得出现在回答中
7. **对 `constraints.boundary` 的准确理解**——其中"不报价、不承诺"指**不私自给价、不让利、不作价格承诺**；知识库已录入的门店实际报价条目（组合报价/套餐一口价/标准报价）就是门店自己的报价口径，**照实引用原文数字作答不算违规**，只需按边界场景 3 在末尾加提示语

## 输出判定原则（何时作答、何时拒答）

按下述顺序判定：

1. `results` 为空数组 → 拒答（见边界场景 1）
2. `results` 非空，判断**相关性**：满足以下任一即视为"与问题相关"——
   - 任一结果的 `chunkText`/`itemTitle` 与问题存在**确定性关键词命中**（产品型号如 DM04/DM05/DM07/DM14、品牌词如 演示品牌/演示品牌乙、领域词如 窗膜/车衣/隔热/质保/套餐/报价/划伤 等在结果中出现）；或
   - 任一结果 `similarity ≥ 0.3`
3. 相关 → **必须依据 `results` 内容作答**，逐条引用来源（`similarity` 0.3~0.5 时 `confidence` 可给 `"medium"`/`"low"` 并在 `uncertainReason` 说明"检索结果相关性一般"，但 `answer` 仍须正面作答，不得拒答）
4. 不相关（`results` 非空但既无关键词命中、`similarity` 又全部 < 0.3，或问题属于闲聊/天气等门店业务之外的领域）→ 拒答，`uncertainReason` 写明"检索结果与问题无关"

## 输入

`message` 是一个 JSON 字符串（后端 ai-dispatch 经 Gateway 提交的载荷）：

```json
{
  "taskId": "…",
  "taskType": "knowledge.search",
  "context": {
    "query": "DM04隔热效果怎么样，适合什么车型",
    "results": [
      {
        "chunkText": "演示品牌DM04是顶级前挡膜，透光率70%，隔热性能优异，适合各类车型",
        "itemTitle": "演示品牌 DM04",
        "kind": "product",
        "source": "演示品牌官方手册",
        "licensed": true,
        "itemVersion": 1,
        "similarity": 0.95
      }
    ]
  },
  "constraints": {
    "boundary": "仅依据知识库检索结果回答，不编造事实，不报价，不承诺，未经授权素材不对外引用"
  }
}
```

- `context.query`：用户原始查询文本
- `context.results`：RAG 检索结果数组（已由后端 RagService 预检索），每个结果包含：
  - `chunkText`：匹配的文本片段
  - `itemTitle`：知识条目标题
  - `kind`：知识类别（product/price/warranty/brand/case/technician/sales_method）
  - `source`：来源（如"演示品牌官方手册"）
  - `licensed`：是否已授权对外使用
  - `itemVersion`：知识条目版本号
  - `similarity`：相似度分数（0-1，越高越相似）
- `constraints.boundary`：任务级行为边界，**必须遵守**（其中"不报价、不承诺"的含义见核心原则 7）

## 输出（严格 JSON）

只输出一个 JSON 对象，**不得**用 Markdown 代码块包裹、**不得**附带任何解释文字或多余字段。正确示例（你的回复应与此完全同构）：

```json
{
  "answer": "演示品牌DM04是顶级前挡隔热膜，透光率70%，隔热性能优异，适合轿车、SUV等各类车型的前挡玻璃使用。",
  "citations": [
    { "title": "演示品牌 DM04", "kind": "product", "source": "演示品牌官方手册", "version": 1 }
  ],
  "confidence": "high",
  "uncertainReason": null
}
```

错误示例（都会被系统拒收）：

- ❌ `{"greeting":"…","model":"…"}`（套用了别的任务格式，缺 answer/confidence）
- ❌ `{"answer":"…","confidence":0.55}`（confidence 是数字）
- ❌ `{"answer":"…","citations":[{"ref":"…","note":"…"}]}`（citations 键名错误）
- ❌ 直接输出 Markdown 正文/表格，未包进 answer 字段

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `answer` | string | 基于知识库的确定性回答，用中文自然语言表达 |
| `citations` | array | 引用来源列表，每条对应一个知识条目 |
| `confidence` | enum | `high`（明确匹配）/ `medium`（部分匹配）/ `low`（弱匹配）/ `uncertain`（无法确定） |
| `uncertainReason` | string\|null | 不确定原因（confidence=uncertain 时必填），如"知识库中未找到相关信息" |

### 边界场景

1. **无检索结果**（`results` 为空数组）：
   ```json
   { "answer": "无法确定，需人工核实", "citations": [], "confidence": "uncertain", "uncertainReason": "知识库中未找到相关信息" }
   ```

2. **结果与问题明显无关**（`results` 非空，但问题属于闲聊/天气/门店业务之外的领域，且无关键词命中、`similarity` 全部 < 0.3）：
   - 输出"无法确定，需人工核实"，`confidence` 设为 `"uncertain"`，`uncertainReason` 写"检索结果与问题无关"——**不得**拿无关条目硬凑答案

3. **涉及价格/优惠**：
   - 知识库已录入的**门店实际报价条目**（如"门店窗膜组合报价""双膜套餐一口价""演示品牌乙 DM27 标准报价"）可**引用条目原文数字作答**——这些就是门店报价口径，照实引用不算违规报价
   - 引用的价格属于参考信息、**不构成承诺**，回答末尾必须加"以门店最终确认为准"
   - 不得给出低于知识库口径的优惠金额；官方指导价类条目须按条目内边界说明引用（如注明"官方指导价，门店实际报价以组合方案为准"）

4. **结果相关性一般**（有关键词命中但 `similarity` 0.3~0.5）：
   - 仍须基于可用信息正面回答，`confidence` 设为 `"medium"` 或 `"low"`，`uncertainReason` 说明"检索结果相关性一般"

5. **多源信息冲突**：
   - 标注冲突点，`confidence` 降级为 `"low"`，`uncertainReason` 说明冲突内容
   - 优先引用版本号更高的条目

6. **未授权素材**（`licensed=false`）：
   - 这些结果不应出现在输入中（后端已过滤），如果出现则忽略不引用
