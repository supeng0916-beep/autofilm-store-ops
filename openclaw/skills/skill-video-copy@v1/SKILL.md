---
name: skill-video-copy
description: "AutoFilm Demo 短视频文案草稿（2026-09-04 运营升级）：依据账号定位（positioning）、可选选题上下文（topicContext：切入角度/钩子方向/参考结构）与知识库素材（materials）创作口播文案草稿。带选题上下文时按其钩子方向开场、按参考结构组织内容。仅依据提供的素材，不诋毁竞品、不用极限词、不承诺价格优惠质保工期。输出为草稿态，人工采用后自行拍摄发布。"
user-invocable: false
version: 1
---

# skill-video-copy（短视频文案草稿）

为门店短视频账号创作**口播文案草稿**。输出为建议/草稿态，仅进入 `ai_tasks.output`，由人采用后自行拍摄与发布（系统不代发，"已复制≠已发送"）。

## 核心原则（硬边界）

1. **仅依据 context.materials 提供的知识库素材创作**——产品参数、价格、质保、品牌荣誉只能来自素材；素材没有的事实不编造
2. **不诋毁竞品**——只讲自家产品优势，不提、不贬低其他品牌
3. **不用极限词**——禁止"最好/第一/顶级/绝对/全网最低"等广告法禁用表述；可用素材中的可证荣誉（如"示例门店已核验奖项（实际荣誉由部署方配置）"）
4. **不承诺**——不承诺价格、优惠、赠品、质保工期；涉及价格只引导"到店/私信详询"
5. 语气贴近 context.style 与 durationSec 时长（约每秒 4-5 字口播），并符合定位的 tone

## 输入

`message` 是 JSON 字符串：

```json
{
  "taskId": "…",
  "taskType": "marketing.video_copy",
  "context": {
    "topic": "夏天车内像蒸笼？",
    "productModel": "DM04",
    "carModel": null,
    "style": "接地气",
    "durationSec": 30,
    "positioning": {
      "store": "本地本地高端汽车膜专营店……",
      "audience": "本地本地 20 万以上车主……",
      "persona": "真人 IP：老板/老板娘出镜……",
      "tone": "本地老板口吻……"
    },
    "topicContext": {
      "angle": "从夏天暴晒实测数据切入……",
      "reason": "季节痛点+本地高温……",
      "hookDirection": "用车内实测温度数字开场",
      "structure": "痛点开场→原理讲解→店内方案→行动号召",
      "type": "hot",
      "source": "……"
    },
    "materials": [
      { "title": "演示品牌隔热膜 DM04（前挡）", "content": "纯虚构素材：用于展示文案生成流程，不提供产品参数", "source": "问答整理/问题1" }
    ]
  },
  "constraints": { "boundary": "…" }
}
```

## 创作要求

- **人设一致（2026-09-04）**：口吻符合 positioning.persona 与 tone——真人老板/技师说话，
  不是广告腔；面向 positioning.audience 说话
- **带 topicContext 时**：hook 按 hookDirection 的方向开场（可优化表达但方向不跑偏）；
  script 按 structure 分段组织；angle 决定切入视角。与 materials 冲突时以素材为准
- **无 topicContext 时**：按 topic 自由创作，结构常规（钩子→价值→证据→行动号召）
- products 参数与事实只能来自 materials；钩子要具体（数字/场景/反差），不要空喊「你知道吗」

## 输出纪律（最高优先级）

- 思考过程一律在内部完成，**最终回复必须且只能是一个 JSON 对象**（按下方模板），不得包裹在 `text` 字段、markdown 代码块或任何叙述性文字里
- 成稿内容必须**完整写进对应字段**（如 script/points）——禁止以"已写入草稿""草稿如下（见附件）"等描述代替实际内容
- 所有字段同时给出（数组可为空），字段名用英文、按模板拼写

## 输出（严格 JSON，无其他文本）

```json
{
  "title": "视频标题（≤20 字，吸引点击但不用极限词）",
  "hook": "开头 3 秒钩子（≤30 字）",
  "script": "完整口播文案（按 durationSec 控制长度；产品事实须来自 materials）",
  "hashtags": ["#汽车贴膜", "#本地"],
  "sourceRefs": ["素材标题引用，如：演示品牌隔热膜 DM04（前挡）"]
}
```

字段类型必须严格一致（hashtags/sourceRefs 为字符串数组，可为空数组）。
