# backend — AutoFilm Demo工作台后端

NestJS 11 + Prisma 7 + PostgreSQL 16 + pgvector。系统底座与业务模块（M01–M12）。

## 常用命令

| 命令                                | 用途                                          |
| ----------------------------------- | --------------------------------------------- |
| `npm run start:dev`                 | 开发模式启动（默认 :8000）                    |
| `npm test`                          | Vitest 集成/单元测试（使用 autofilm_test 库） |
| `npm run lint` / `npm run lint:fix` | ESLint + Prettier 检查/修复                   |
| `npm run typecheck`                 | tsc --noEmit                                  |
| `npm run check-db`                  | 数据库连通性 + pgvector 检查                  |
| `npx prisma migrate dev`            | 生成并应用迁移                                |

## 分层约定（规范 S08）

controller（路由/入参校验）→ service（业务规则）→ repository（Prisma 数据访问）。
controller 禁止直接调用 Prisma client；入参一律 Zod 校验。

环境变量见 `.env.example`（规范 S04：凭证零入库）。
