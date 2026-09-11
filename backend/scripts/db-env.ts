/** 数据库连接串守卫：WG_DATABASE_URL 缺失/空白时给出明确错误与处置指引。
 * check-db.ts 与 prisma.config.ts 共用，避免空串透传后出现晦涩连接错误。 */
export function requireDbUrl(env: NodeJS.ProcessEnv): string {
  const url = env.WG_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      '缺少环境变量 WG_DATABASE_URL。请在 backend/.env 配置（参考 .env.example），' +
        '或命令行显式传入，例如：WG_DATABASE_URL=postgresql://autofilm:autofilm@localhost:5432/autofilm_dev npm run check-db',
    );
  }
  return url;
}
