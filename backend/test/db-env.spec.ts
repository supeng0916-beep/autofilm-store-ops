import { describe, expect, it } from 'vitest';

import { requireDbUrl } from '../scripts/db-env';

describe('requireDbUrl（WG_DATABASE_URL 守卫）', () => {
  it('返回合法连接串', () => {
    const url = requireDbUrl({ WG_DATABASE_URL: 'postgresql://u:p@localhost:5432/db' });
    expect(url).toBe('postgresql://u:p@localhost:5432/db');
  });

  it('缺失时抛出含指引的错误', () => {
    expect(() => requireDbUrl({})).toThrow(/WG_DATABASE_URL/);
    expect(() => requireDbUrl({ WG_DATABASE_URL: '   ' })).toThrow(/\.env/);
  });
});
