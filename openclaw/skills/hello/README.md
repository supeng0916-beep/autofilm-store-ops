# hello skill（P3-00 AI 通道验证）

`hello` 是AutoFilm Demo 后端与 OpenClaw 之间的**通道验证技能**，自 P3-00 起存在两种形态：

| 形态 | 位置 | 用途 |
|---|---|---|
| SKILL.md 技能定义 | `skills/skill-hello/SKILL.md` | 真实模型环境：OpenClaw 加载后由模型按指令输出严格 JSON |
| echo 回退脚本 | `skills/hello/index.ts` | 无模型环境：纯脚本回显，验证「提交→结果」链路本身 |

两者输出契约一致，均满足后端 `HelloOutputSchema`：`{"greeting":"…","model":"…"}`。

## echo 回退脚本（本文件同目录）

自包含 TypeScript，仅依赖 Node ≥22 内置模块，不依赖 backend 源码、不依赖任何第三方包。

- 输入：stdin 一段 JSON（`taskId`/`taskType`/`context`，与后端提交载荷同构）。
- 输出：stdout 单行严格 JSON `{"greeting":"你好，<name>","model":"echo"}`（无代码块、无多余字段）。
- `context.name` 缺省/非字符串时按 `AutoFilm Demo` 处理；非 JSON 输入按缺省处理。
- 约束：不调模型、不回调、不签名、不访问任何工具/客户数据/凭证。

运行示例：

```bash
echo '{"taskId":"t1","taskType":"hello","context":{"name":"AutoFilm Demo"}}' \
  | node --experimental-strip-types openclaw/skills/hello/index.ts
```

> 说明：P3-00 之前本目录脚本是「stdin 提交 + HTTP 回调 + HMAC 签名」的双模式脚本，现已按 Gateway 协议重写为纯 echo 回退；真实模型调用改由 `skill-hello/SKILL.md` 承载，回调方向（HTTP POST）不再使用。
