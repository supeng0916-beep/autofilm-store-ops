// Prisma CLI 配置：连接串经守卫校验（规范 S04：凭证只进 .env）
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

import { requireDbUrl } from './scripts/db-env';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: requireDbUrl(process.env),
    // 影子库仅 migrate diff/dev 复放迁移用（本地临时库，地址走环境变量，S04）
    ...(process.env.WG_SHADOW_DATABASE_URL
      ? { shadowDatabaseUrl: process.env.WG_SHADOW_DATABASE_URL }
      : {}),
  },
});
