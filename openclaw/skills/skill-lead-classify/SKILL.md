---
name: skill-lead-classify
description: "AutoFilm Demo 客资意向分级：依据脱敏后的客资上下文（车型/需求/来源/阶段/最近对话摘要/回复时间）输出建议态意向等级，输出严格 JSON（level/confidence/evidence/missingInfo/nextAction）。定级规则：成交级信号（已付定金/已成交/客户说出明确提车施工时间/已约定到店）直接判 high（无需已进入排期沟通）（缺失信息不影响等级）；明确车型+产品需求或主动问价问档期无成交信号判 mid；仅初步接触判 low/pending。回复速度仅弱信号。不报价、不臆造、不使用任何工具。"
user-invocable: false
---

# skill-lead-classify（客资意向分级）

本技能为门店销售对客户做**意向分级建议**（`high`/`mid`/`low`/`pending`），供销售参考并最终由人工确认。输出为**建议态**，只进入后端 `ai_tasks.output`，绝不写业务字段，也不触发任何对外动作；人工确认后才落 `lead.intentLevel`。

## 输入

`message` 是一个 JSON 字符串（后端 ai-dispatch 经 Gateway 提交的载荷）：

```json
{
  "taskId": "…",
  "taskType": "lead.classify",
  "context": {
    "refId": "ref_…",
    "sourcePlatform": "抖音",
    "businessType": "auto_film",
    "target": "特斯拉 Model Y",
    "productNeed": "改色膜",
    "rawNeed": "想贴改色膜，预算 6000 左右，最好这个月内",
    "stage": "communicating",
    "lastFollowUpResult": "客户表示周末有空，问能否约到店",
    "receivedAt": "2026-08-14T09:00:00.000Z",
    "firstCustomerReplyAt": "2026-08-14T09:30:00.000Z"
  },
  "constraints": {
    "boundary": "你是门店销售助理，仅依据给定脱敏客资上下文与最近对话摘要对客户意向分级，输出为建议态，只进入 ai_tasks.output，绝不写业务字段、不报价、不臆造事实、不使用任何工具。",
    "evidenceCaliber": "证据口径：回复速度快慢仅为弱信号，不得作为定级主依据；近期施工时间、明确车型需求、主动问价或问档期、愿意到店预约属于强证据，可支撑更高等级；证据不足时判 pending 并在 missingInfo 列出待补信息。"
  }
}
```

- `context.refId`：客户假名 ID（脱敏后标识，**不是**真实姓名/手机/微信）。
- `context.sourcePlatform`：来源渠道（抖音/4S店/老客户转介绍/小红书/视频号/到店等）。
- `context.businessType`：业务类型 `auto_film`（车膜）或 `home_film`（住宅膜）。
- `context.target`：车型或住宅对象；`productNeed` 为客户明确询问的产品；`rawNeed` 为客户原始需求原话。
- `context.stage`：当前阶段；`context.lastFollowUpResult`：最近一次跟进/对话结果（可为 null）。
- `context.receivedAt` / `context.firstCustomerReplyAt`：派发接收时间与首次回复时间（用于评估「回复速度」这一弱信号，可为 null）。
- `constraints.boundary` 与 `constraints.evidenceCaliber`：任务级行为边界与证据口径，**必须逐条遵守**。

## 输出（严格 JSON）

只输出一个 JSON 对象，**不得**用 Markdown 代码块包裹、**不得**附带任何解释文字或多余字段：

```json
{
  "level": "high",
  "confidence": 0.85,
  "evidence": ["明确车型需求：特斯拉 Model Y", "主动问档期：问能否约到店"],
  "missingInfo": ["是否已确认具体颜色"],
  "nextAction": "联系客户确认颜色偏好并预约到店时间"
}
```

字段契约（后端用 `LeadClassifyOutputSchema` 校验，`level` 缺失或非法、`confidence` 越界会判输出无效并降级）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `level` | 是 | 意向等级 `high`/`mid`/`low`/`pending`（证据不足判 `pending`） |
| `confidence` | 是 | 置信度，0～1 之间的小数 |
| `evidence` | 否 | 支撑该等级的证据清单（缺省 `[]`） |
| `missingInfo` | 否 | 缺失的关键信息清单（缺省 `[]`，供销售补问） |
| `nextAction` | 否 | 建议下一动作（如「预约到店」「补问车型/档期」） |

## 约束（硬性，逐条）

1. **定级规则（决定性，2026-08-27 复评修订）**：
   - **成交级信号 → 直接判 `high`（confidence ≥0.75）**：已付定金/已成交、**明确的提车或施工时间**（如「明天提车」「月底提车」「下周提车」——客户说出具体时间即算，**无需已进入排期沟通**）、双方已约定到店或施工。**不得因还有缺失信息而降为 pending**——missingInfo 照常列出，但不影响等级。
   - **明确意向 → `mid`（confidence 约 0.6~0.7）**：有明确车型+产品需求、或主动问价问档期，但无成交级信号。
   - **仅初步接触 → `low` 或 `pending`**：无强证据；判 pending 须在 missingInfo 列出待补信息（如车型/颜色/档期/预算），不臆造等级。
   - 回复速度快慢**只是弱信号**，不得作为定级主依据。
2. **只依据给定 `context`**：不得臆造客户的姓名、联系方式、车型、需求或任何上下文之外的事实。
3. **不报价、不承诺**：不得给出具体金额、优惠、质保、工期或赠品承诺；涉及价格话题只写「引导到店 / 转人工报价」。
4. **建议态措辞**：所有输出是给销售参考的建议，用「建议 / 可考虑 / 建议确认」等措辞，不做确定性判定。
5. **不使用任何工具**（biz-query / knowledge-search 白名单本阶段均不启用），不访问客户数据、不读取凭证、不发起网络请求；只做「读取输入 → 分级 → 输出严格 JSON」。

## 示例

**示例 1：高意向（强证据：明确车型＋主动问档期）**

输入 `context`：`{ "refId": "ref_1", "sourcePlatform": "4S店", "businessType": "auto_film", "target": "理想 L9", "productNeed": "全车隐形车衣", "rawNeed": "4S 店介绍的，想贴全车车衣，预算 15000", "stage": "communicating", "lastFollowUpResult": "客户问这周末能否到店看车衣样板", "receivedAt": "2026-08-10T09:00:00.000Z", "firstCustomerReplyAt": "2026-08-10T09:30:00.000Z" }`

输出：

```json
{
  "level": "high",
  "confidence": 0.9,
  "evidence": ["明确车型需求：理想 L9", "主动问档期：问这周末能否到店", "4S 店转介绍"],
  "missingInfo": [],
  "nextAction": "确认到店时间并准备车衣样板对比"
}
```

**示例 2：低意向（仅了解价格，无强证据）**

输入 `context`：`{ "refId": "ref_2", "sourcePlatform": "小红书", "businessType": "home_film", "target": "住宅客厅玻璃", "productNeed": "隔热膜", "rawNeed": "随便看看玻璃隔热膜价格", "stage": "new", "lastFollowUpResult": null, "receivedAt": "2026-08-14T09:00:00.000Z", "firstCustomerReplyAt": null }`

输出：

```json
{
  "level": "low",
  "confidence": 0.6,
  "evidence": ["仅询问价格，无明确施工时间或预约意愿"],
  "missingInfo": ["住宅朝向与玻璃面积", "主要想解决隔热还是隐私"],
  "nextAction": "简单介绍住宅膜优势，补问核心诉求后再评估"
}
```

**示例 3：证据不足判 pending（首次回复，弱信号）**

输入 `context`：`{ "refId": "ref_3", "sourcePlatform": "抖音", "businessType": "auto_film", "target": null, "productNeed": null, "rawNeed": "在吗", "stage": "contacted", "lastFollowUpResult": "客户回复「在」", "receivedAt": "2026-08-14T09:00:00.000Z", "firstCustomerReplyAt": "2026-08-14T09:05:00.000Z" }`

输出：

```json
{
  "level": "pending",
  "confidence": 0.4,
  "evidence": [],
  "missingInfo": ["车型", "具体需求", "是否近期有施工计划"],
  "nextAction": "引导客户说明车型与需求后再分级"
}
```

**示例 4：成交级信号直接判 high（2026-08-27 复评修订——即使还有缺失信息）**

输入 `context`：`{ "refId": "ref_4", "sourcePlatform": "抖音", "businessType": "auto_film", "target": "蔚来新ES8", "productNeed": "演示入门款车衣", "rawNeed": "明天提车，预算不想太贵", "stage": "communicating", "lastFollowUpResult": "客户确认明天提车并送店施工，价格当面谈；老板已推荐演示款车衣并发实拍视频", "receivedAt": "2026-08-26T09:00:00.000Z", "firstCustomerReplyAt": "2026-08-26T09:30:00.000Z" }`

输出：

```json
{
  "level": "high",
  "confidence": 0.85,
  "evidence": ["明确的施工时间：客户明天提车并送店施工", "明确车型与产品需求：蔚来新ES8+演示款车衣", "已进入当面成交沟通（价格当面谈）"],
  "missingInfo": ["最终价格未当面确认"],
  "nextAction": "确认明天到店时间并提前准备施工方案与演示款车衣样板"
}
```

（注意示例 4：missingInfo 非空**不**改变 high 等级——成交级信号已足够。）
