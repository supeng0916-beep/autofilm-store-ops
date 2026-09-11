import type { JwtPayload } from '../../auth/auth.types';

/** 聚合区块（V1.5 spec §3.3）：key=区块名、summary=一行结论（含计数）、items=明细行（≤10） */
export interface StructuredContextBlock {
  key: string;
  summary: string;
  items: string[];
}

/** 角色聚合器接口：确定性查询，AI 只组织语言（批次 2 晨报复用同一实现） */
export interface RoleContextAggregator {
  readonly persona: 'boss' | 'manager';
  collect(actor: JwtPayload): Promise<StructuredContextBlock[]>;
}

/** 区块条目上限（spec §3.3：每区块 ≤10、总量 ≤4KB） */
export const BLOCK_ITEM_LIMIT = 10;

export const emptyBlock = (key: string): StructuredContextBlock => ({
  key,
  summary: '暂无数据',
  items: [],
});

/** 序列化为技能输入：【key】summary 换行接明细行；空 items 只留 summary */
export function serializeStructuredContext(blocks: StructuredContextBlock[]): string {
  return blocks
    .map((b) => `【${b.key}】${b.summary}${b.items.length ? `\n${b.items.join('\n')}` : ''}`)
    .join('\n\n');
}
