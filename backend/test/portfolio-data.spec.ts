import { describe, expect, it } from 'vitest';

import { KNOWLEDGE_SEED_ITEMS } from '../scripts/seed-knowledge.data';

describe('作品集私有知识边界', () => {
  it('新安装不内置任何门店产品、报价或经营知识', () => {
    expect(KNOWLEDGE_SEED_ITEMS).toEqual([]);
  });
});
