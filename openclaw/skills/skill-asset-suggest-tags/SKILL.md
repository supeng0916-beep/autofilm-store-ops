---
name: skill-asset-suggest-tags
description: "AutoFilm Demo 素材标签建议：输入素材文件名（file）与元数据（kind/carModel/productModel/stage/title），输出严格 JSON {\"tags\": [...]}，≤8 个、每个 ≤30 字，从文件名与元数据推断车型/产品/施工阶段标签（如「施工前」「施工中」「完工」、车型、DM04）。仅依据提供字段推断，无把握返回空数组，不编造事实，不访问任何工具。"
user-invocable: false
---

# skill-asset-suggest-tags（素材标签建议）

为素材库上传的图片/视频/文档建议检索标签。输出为建议态，仅进入 `ai_tasks.output`，由人采纳后经素材编辑写入（系统不代写 tags 字段）。

## 输入

`message` 是 JSON 字符串（后端序列化后的提交载荷）：

```json
{
  "taskId": "…",
  "taskType": "asset.suggest_tags",
  "context": {
    "file": "model-y-dm04-完工.jpg",
    "kind": "finished",
    "carModel": "Model Y",
    "productModel": "DM04",
    "stage": "全车贴膜完成",
    "title": "完工案例"
  },
  "constraints": { "boundary": "仅输出标签数组，不编造事实，不访问工具" }
}
```

- `file`（文件名，不含服务器路径）/`kind`/`title` 必有；`carModel`/`productModel`/`stage` 可能为 null，为 null 时不得作为推断依据。
- 键名用 `file` 而非 fileName：后端脱敏器将 *name 键按人名脱敏（A04），fileName 会失真。
- 标签从 file 与上述元数据推断：施工阶段（如「施工前」「施工中」「完工」）、车型、产品型号（如 DM04/DM10/DM90）、业务类型（如窗膜/改色/车衣）等。

## 输出纪律（最高优先级）

- 思考过程一律在内部完成，**最终回复必须且只能是一个 JSON 对象**，不得用 Markdown 代码块包裹、不得附带任何解释文字或多余字段。
- `tags` 字段必须给出（可为空数组），字段名按模板拼写。

## 输出（严格 JSON，无其他文本）

```json
{ "tags": ["完工", "Model Y", "DM04", "窗膜"] }
```

- `tags`（必填，字符串数组）：≤8 个，每个 ≤30 字；中文短语优先，与素材内容直接相关。
- 无把握时返回 `{ "tags": [] }`——宁可空数组，不编造标签。

后端用输出 schema 校验：`tags` 非数组、超过 8 个或单项超过 30 字均判输出无效并降级。

## 约束（硬性）

- 仅依据输入提供的 文件名（file）与元数据推断，不补充外部信息、不编造事实。
- 不使用任何工具（biz-query / knowledge-search 均不启用），不访问客户数据，不读取凭证文件，不发起网络请求。
- 只做「读取输入 → 推断标签 → 输出严格 JSON」，不执行任何对外动作。
