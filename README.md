# AutoFilm Ops

**个人独立开发的 AI Agent 业务项目：让模型建议进入可核查、可修改、可追踪的工作流程。**

项目面向汽车服务业务，把客户跟进、知识查询、预约交付和经营查看连接起来。Agent 根据角色和业务上下文提供建议，能够按需查询业务事实；应用负责权限、任务状态、结果校验和人工处理。

这份作品重点展示：如何把一次模型调用接进业务系统，以及模型出错、信息不足或需要人工判断时，系统如何继续工作。

[Agent 设计](#ai-agent-核心设计) · [界面截图](#界面预览) · [项目案例](#项目案例) · [启动服务](#启动服务) · [事实与证据](docs/portfolio/FACTS.md)

## 项目解决什么问题

| 业务问题 | 项目中的处理方式 |
| --- | --- |
| 对话建议与客户当前情况脱节 | 后端按角色准备业务快照、相关知识和最近对话，再提交 Agent 任务 |
| 模型返回了内容，却难以判断是否可用 | 结果按任务契约校验，失败原因、状态与事件留存，支持重试和人工接管登记 |
| 草稿、人工修改和实际跟进混在一起 | AI 原建议与人工改写分开保存，复制和登记发送各自留痕 |
| 团队经验难以复用，直接入库又容易传播错误 | 陪练和经验提炼先生成知识草稿，经人工批准后再参与后续检索 |

## AI Agent 核心设计

**先给上下文，再允许有限查询。** 老板、店长和销售助手由后端路由到不同技能；其中经营与执行快照由确定性查询生成。网关可以调用只读 MCP 工具补充总览、排期、工单或知识信息。[角色与工具证据](docs/portfolio/FACTS.md)

**把生成与执行分开。** Agent 返回建议、草稿或结构化结果，后端经过归一化、Schema 与已接入的内容规则检查后保存。权限、状态流转和业务写入由程序控制；跟进草稿服务不会直接对外发送消息。[案例：跟进草稿](docs/portfolio/CASES.md#案例一让跟进草稿可修改可追溯)

**为失败保留出口。** 任务记录时限、状态变化、结果、用量和错误信息；部分入口支持自动重试，控制台提供手动重试和人工接管登记。知识不足时保留不确定性，不能把格式正确当作事实正确。[案例：任务执行](docs/portfolio/CASES.md#案例二让-agent-任务失败后仍可排查)

底层由 Vue 3、NestJS、PostgreSQL / Prisma 和外部 OpenClaw Gateway 构成。独立知识问答使用 pgvector；具体职责、数据模型和取舍见 [架构说明](docs/portfolio/ARCHITECTURE.md)。

```mermaid
flowchart LR
  UI["业务页面与角色助手"] --> API["鉴权与业务服务"]
  API --> Data["业务事实与事件记录"]
  API --> Dispatch["任务调度与输入脱敏"]
  Dispatch --> Gateway["外部 Agent 网关"]
  Gateway --> Tools["只读业务查询"]
  Tools --> Gateway
  Gateway --> Check["结果校验与状态落库"]
  Check --> Human["人工查看与修改"]
  Human --> API
```

## 界面预览

下图来自真实前端页面，所有人物、任务、金额和指标均为合成演示数据；它们用于说明交互，不是实际客户记录、测试统计或模型效果。可按“首页工作台 → Agent 任务 → 知识管理 → 业务复盘”的顺序阅读；讲解脚本见 [演示流程](docs/portfolio/DEMO.md)。

![AI 任务控制台：合成数据演示](docs/screenshots/04-ai-console.png)

![首页工作台：合成数据演示](docs/screenshots/02-dashboard.png)

<details>
<summary>查看知识管理、经营复盘与项目入口截图</summary>

![知识管理：空白演示知识库](docs/screenshots/05-knowledge.png)

![经营复盘：合成数据演示](docs/screenshots/03-analytics.png)

![项目入口](docs/screenshots/01-entry.png)

</details>

## 个人贡献

本项目由我独立开发。我将业务流程整理为前后端页面、接口与数据模型，并将角色助手、工具查询、任务执行、人工草稿和审计记录接入同一应用。

## 项目案例

### 跟进草稿：保留模型建议与人工修改

客户跟进需要建议，也需要知道最终采用了什么。项目将生成、编辑、复制和登记发送分成独立动作：AI 原建议保存在任务输出，人工改写和操作记录写入客资事件。复制不会自动标记为已发送；登记发送需要填写依据，服务本身不发送外部消息。

我独立完成页面、接口、数据记录与 Agent 任务衔接。对应测试校验人工编辑不覆盖 AI 输出、复制不产生登记发送事件，以及非负责人不能修改别人的草稿。[实现与测试](docs/portfolio/CASES.md#案例一让跟进草稿可修改可追溯)

### Agent 执行：失败后能定位和恢复

模型可能超时或返回不符合契约的内容。统一调度层记录任务时限、状态和事件；网关按任务 ID 隔离会话，结果经归一化与 Schema 校验，工具查询有次数限制和审计。部分入口自动重试，控制台支持手动重试与人工接管登记。

我独立完成调度层、网关适配、只读查询工具和控制台集成。测试覆盖超时降级、重复回调与工具计数。当前工具身份归属仍面向单实例；接管登记也不等于网关运行已取消。[实现与测试](docs/portfolio/CASES.md#案例二让-agent-任务失败后仍可排查)

### 知识与陪练：经验先审核，再参与回答

训练对话不能直接成为可信知识。项目将模拟练习、教练点评、经验提炼和知识生效分开；提炼结果先创建知识草稿，经人工批准后生效。独立知识问答过滤授权条目，缺少可用来源时返回不确定。

我独立完成训练会话、经验卡、知识工作流与模型任务衔接。测试覆盖草稿状态、无效输出拒收和他人会话不可读取。角色对话、MCP 与独立问答的授权过滤尚未统一，仍需完善。[实现与测试](docs/portfolio/CASES.md#案例三让经验先经过审核再参与回答)

项目周期、实际部署范围与量化效果没有足够证据，未写成成果。需要补充的信息见 [贡献核对表](docs/portfolio/CONTRIBUTIONS.md)。

## 启动服务

### 1. 环境要求

| 工具 | 要求 / 用途 |
| --- | --- |
| Node.js | 22 或更新版本；前后端均在 package.json 声明最低版本 |
| npm | 使用前后端各自的 package-lock.json 安装依赖 |
| PostgreSQL | 16，需提供 pgvector 扩展 |
| Git、Make | 克隆源码与运行根目录快捷命令 |
| OpenClaw / 模型账号 | 可选；浏览非 AI 业务页面不需要 |

克隆仓库，在项目根目录准备依赖：

```bash
git clone https://github.com/supeng0916-beep/autofilm-store-ops.git
cd autofilm-store-ops
node --version
make setup
```

`make setup` 安装两端依赖、从 `backend/.env.example` 创建本机配置（已有文件保留）、生成 Prisma Client，并启用仓库 Git 钩子。它不会创建数据库或导入业务数据。

### 2. 准备独立开发数据库

以下两种方式任选一种。示例账号密码仅供本机开发，数据库端口只绑定回环地址。

**方式 A：Docker（macOS / Linux / Windows 上已配置 Docker 的终端）**

```bash
docker run --name autofilm-postgres \
  -e POSTGRES_USER=autofilm \
  -e POSTGRES_PASSWORD=autofilm \
  -e POSTGRES_DB=autofilm_dev \
  -p 127.0.0.1:5432:5432 \
  -v autofilm-pgdata:/var/lib/postgresql/data \
  -d pgvector/pgvector:pg16

docker exec autofilm-postgres pg_isready -U autofilm -d autofilm_dev
docker exec autofilm-postgres psql -U autofilm -d autofilm_dev \
  -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

第二次运行用 `docker start autofilm-postgres`。命名数据卷保留数据库内容。

**方式 B：macOS 已安装 PostgreSQL 16**

```bash
brew install postgresql@16 pgvector
brew services start postgresql@16
# Apple Silicon 默认路径；Intel Mac 按实际 Homebrew 前缀调整
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
createuser --createdb autofilm
psql -d postgres -c "ALTER USER autofilm PASSWORD 'autofilm';"
createdb -O autofilm autofilm_dev
psql -d autofilm_dev -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

已有同名角色或数据库时跳过相应创建命令。必须确认 pgvector 安装在 PG16 对应目录；如果扩展不可用，可使用方式 A。

### 3. 配置、迁移与创建开发账号

编辑 `backend/.env`，核对：

```dotenv
WG_DATABASE_URL=postgresql://autofilm:autofilm@localhost:5432/autofilm_dev
WG_PORT=8000
WG_JWT_SECRET=请替换为至少32字符的随机字符串
WG_SEED_PASSWORD=请替换为自己的本机开发密码
WG_HEARTBEAT=off
WG_INDUSTRY_DAILY=off
```

可运行 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成随机密钥，并仅填入本机 `.env`。

```bash
make check-db
make migrate
make seed
```

`make check-db` 检查连接与 pgvector；`make migrate` 执行 `prisma migrate deploy`，应用仓库现有迁移；`make seed` 写入五个角色及占位账号，不覆盖已有口令。

| 用户名 | 角色 | 初始密码 |
| --- | --- | --- |
| `ph-boss` | 老板 / 经营查看与审批 | 本机 `WG_SEED_PASSWORD` |
| `ph-store-manager` | 店长 / 运营与排期 | 同上 |
| `ph-sales-ops` | 销售 / 客资跟进 | 同上 |
| `ph-recorder` | 施工记录员 | 同上 |
| `ph-sys-admin` | 系统管理员 / 配置 | 同上 |

这是 `make seed` 的账号，不要与可选 `seed:accounts` 脚本生成的 `demo-*` 账号混用。修改环境变量不会重置已存在账号的密码。

### 4. 启动前后端

```bash
make dev
```

- 前端：<http://localhost:5173>
- 后端健康检查：<http://localhost:8000/api/v1/health>
- API 前缀：`/api/v1`，开发时由 Vite 将 `/api` 代理到后端 `8000` 端口。

浏览器打开前端，点击“进入工作台”，使用上表账号登录。建议先用 `ph-boss` 浏览工作台、客资、审批与经营复盘，再用 `ph-sys-admin` 查看系统相关权限。

也可以分别开两个终端：

```bash
# 终端一（仓库根目录）
cd backend
npm run start:dev
```

```bash
# 终端二（仓库根目录）
cd frontend
npm run dev
```

按 `Ctrl+C` 停止对应服务。若使用 `make dev` 后仍有子进程占用端口，可在对应终端停止它；不要终止不属于本项目的数据库或服务。

### 5. 可选：合成数据与 AI

- `make seed-p3` 导入既有 P3 合成客资，用于体验队列与详情；会写数据库，建议只对独立开发库执行。
- 知识库、报价图与素材库默认为空。可以从页面创建自己编写的虚构知识草稿；`npm run seed:knowledge` 在本作品集版会直接跳过，不连接数据库或模型。
- 截图数据仅用于拍摄，不会由 `make seed` 自动写入数据库。不要把截图中的统计数字当作应用初始化结果。
- AI 属于可选接入：按 [网关说明](openclaw/README.md) 配置 OpenClaw，再在本机填写 `.env.example` 中已注释的网关地址、token、回调密钥、MCP token 和 Embedding 配置。不同接口有各自的最低长度校验。
- 未配置网关时，AI 任务入口会拒绝提交或提示不可用；未配置 Embedding 时，语义检索可能为空。普通客户、预约和施工业务可独立运行。
- 真实模型会产生调用费用。技能文件在本仓库中用于展示编排与约束设计；脱敏后的示例尚未进行真实模型业务评测，不表示发布验收通过。


## 测试与构建

只读治理检查，不连接数据库：

```bash
node --test scripts/governance.test.mjs
node scripts/governance.mjs
```

前端检查与构建：

```bash
cd frontend
npm run lint
npm run typecheck
npm test
npm run build
```

后端测试会迁移并写入测试库，请先创建独立的 `autofilm_test`：

```bash
# Docker 方式；macOS 本机可用 createdb -O autofilm autofilm_test
docker exec autofilm-postgres createdb -U autofilm autofilm_test
export WG_TEST_DATABASE_URL='postgresql://autofilm:autofilm@localhost:5432/autofilm_test'
bash scripts/ci.sh
```

完整 CI 按顺序运行治理、后端 Lint / 类型 / 测试、前端类型 / Lint / 测试 / 构建与密钥扫描。它不是只读命令。没有配置向量服务时，已有的一项知识搜索集成测试依赖向量返回，可能失败；本轮实际结果和限制见 [验证记录](docs/VALIDATION.md)。

后端构建：`cd backend && npm run build`。如需单进程预览，先构建两端，在后端进程设置 `WG_STATIC_DIR=../frontend/dist`，再运行 `npm run start:prod`，访问后端端口即可。`vite preview` 用于检查前端构建产物，不自动提供业务 API。

### 常见问题

| 现象 | 排查方式 |
| --- | --- |
| Prisma Client 不存在 | 在 backend 执行 `npx prisma generate`；先准备 `.env` |
| 环境变量校验失败 | 核对 `.env.example`；JWT 至少 32 字符，可选 AI 项不使用时保持注释 |
| 数据库拒绝连接 | 确认 PostgreSQL 已启动、端口/账号/库名与连接串一致 |
| `vector` 扩展不可用 | 核对扩展与 PostgreSQL 主版本一致，或使用含扩展的 Docker 镜像 |
| 登录失败 | 确认运行过 `make seed`，使用 `ph-*` 账号与建号时的密码 |
| 页面为空 / 没有截图中的指标 | 新数据库无业务数据是预期行为；截图使用独立合成数据 |
| 前端 API 502 / 网络错误 | 确认后端健康检查正常；更改后端端口时同步 Vite 代理 |
| AI / 知识检索不可用 | 先完成可选网关和 Embedding 配置，再检查权限、开关与知识状态 |

## 当前验证与边界

实现有对应测试，证据按“源码可确认”“测试包含断言”“本轮实际执行”分别记录，见 [验证记录](docs/VALIDATION.md) 和 [事实清单](docs/portfolio/FACTS.md)。本稿不把历史测试数当成本轮结果，也不把程序测试当作真实模型评测。

当前需保留的边界：

- 角色化助手通过后端路由组织，尚无自动相互委派的多 Agent 网络。
- MCP 使用共享网关令牌，调用归属面向单实例；多租户和高并发隔离仍需完善。
- 独立知识问答、对话预检索与 MCP 知识工具的授权过滤不同。
- 流式预览先于完整输出校验；内容仍需人工判断。费用是估算，任务 token 阈值仅告警。
- 公开候选不含真实客户案例、产品报价或运行凭据；新的发布必须使用重新生成的干净历史。[隐私范围](docs/PRIVACY_EXPORT.md)

当前未声明开源许可证。源码可访问不等同于任意复制、再分发或商用授权。
