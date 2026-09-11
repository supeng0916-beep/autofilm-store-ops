/** 测试前置：把迁移部署到测试库，保证集成测试面对最新 schema。
 * dotenv 不覆盖已存在的环境变量，故此处显式设置的 WG_DATABASE_URL 优先生效。 */
import { execFileSync } from 'node:child_process';

import { TEST_DATABASE_URL } from './test-env';

export function setup(): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WG_DATABASE_URL: TEST_DATABASE_URL,
    },
    stdio: 'inherit',
  });
}
