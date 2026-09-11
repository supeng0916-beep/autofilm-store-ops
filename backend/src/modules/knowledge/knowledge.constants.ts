/** 知识类别（任务书 M06，P4-01 准备清单 §一） */
export const KNOWLEDGE_KIND = {
  PRODUCT: 'product',
  PRICE: 'price',
  WARRANTY: 'warranty',
  BRAND: 'brand',
  CASE: 'case',
  TECHNICIAN: 'technician',
  SALES_METHOD: 'sales_method',
  COMPETITOR: 'competitor', // 同行信息（V2.1：人工浏览+AI 提炼，内部参考 licensed=false）
  CARE: 'care', // 交付养护说明（2026-08-28 bug2：施工单养护草稿优先素材）
} as const;

export type KnowledgeKind = (typeof KNOWLEDGE_KIND)[keyof typeof KNOWLEDGE_KIND];

export const KNOWLEDGE_KIND_VALUES = Object.values(KNOWLEDGE_KIND) as [
  KnowledgeKind,
  ...KnowledgeKind[],
];

export const KNOWLEDGE_KIND_LABEL: Record<KnowledgeKind, string> = {
  product: '产品',
  price: '价格',
  warranty: '质保',
  brand: '品牌规范',
  case: '案例',
  technician: '技师专长',
  sales_method: '销售方法',
  competitor: '同行信息',
  care: '交付养护',
};

/** 价格类知识：生效须走审批（P4-01 验收标准） */
export const PRICE_KINDS: KnowledgeKind[] = [KNOWLEDGE_KIND.PRICE];

/** 审批类型：知识价格生效 */
export const APPROVAL_TYPE_KNOWLEDGE_ACTIVATE = 'knowledge.activate';

/** 门店知识源目录名（仓库根下，#14）：知识 source 路径与「查看原始文件」端点共用此白名单根 */
export const KNOWLEDGE_SOURCE_DIR = '门店知识源';
