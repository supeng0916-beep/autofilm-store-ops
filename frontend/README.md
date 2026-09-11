# frontend — AutoFilm Demo工作台前端

Vue 3 + Vite 8 + Pinia 4 + Vue Router 5 + Element Plus + TypeScript strict。

## 常用命令

| 命令                                | 用途                                     |
| ----------------------------------- | ---------------------------------------- |
| `npm run dev`                       | 开发服务（:5173，/api 代理到后端 :8000） |
| `npm test`                          | Vitest 组件/单元测试                     |
| `npm run lint` / `npm run lint:fix` | ESLint + Prettier 检查/修复              |
| `npm run build`                     | 类型检查 + 生产构建                      |

目录约定（规范 S14）：views（页面）/ components（组件）/ composables（逻辑）/ stores（状态）。
接口类型由后端 OpenAPI 生成（S13，P1 后接入），禁止手写接口类型。
