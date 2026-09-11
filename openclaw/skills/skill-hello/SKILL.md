---
name: skill-hello
description: "AutoFilm Demo AI 通道验证：输入 JSON（taskId/taskType/context），输出严格 JSON {\"greeting\":\"…\",\"model\":\"…\"}，不访问任何工具或客户数据。"
user-invocable: false
---

# skill-hello（AI 通道验证）

本技能是AutoFilm Demo 后端（NestJS ai-dispatch）与 OpenClaw 之间的通道验证任务。后端经 Gateway 协议以 `agent` 方法发起一次 run，`message` 字段为本技能输入。

## 输入

`message` 是一个 JSON 字符串（后端序列化后的提交载荷）：

```json
{
  "taskId": "…",
  "taskType": "hello",
  "context": { "name": "AutoFilm Demo" },
  "constraints": {}
}
```

- `context.name` 缺省或非字符串时按 `AutoFilm Demo` 处理。
- `constraints` 是任务级约束，本技能固定为「通道验证」。

## 输出（严格 JSON）

只输出一个 JSON 对象，**不得**用 Markdown 代码块包裹、**不得**附带任何解释文字或多余字段：

```json
{ "greeting": "你好，AutoFilm Demo", "model": "MiniMax-M3" }
```

- `greeting`（必填，非空字符串）：一句简短中文问候。
- `model`（可选，字符串）：本次实际使用的模型名（回显）。

后端用 `HelloOutputSchema` 校验输出，`greeting` 缺失/空串会判输出无效并降级。

## 约束（硬性）

- 不使用任何工具（biz-query / knowledge-search 白名单本阶段均不启用）。
- 不访问客户数据、不读取任何凭证文件、不发起网络请求。
- 只做「读取输入 → 生成问候 → 输出严格 JSON」，不执行任何对外动作。
