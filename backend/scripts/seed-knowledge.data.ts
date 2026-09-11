/** 作品集版不内置门店产品、报价、质保或经营资料。
 * 保留类型与导出接口，确保既有初始化调用兼容；实际知识由使用者另行录入。 */
export interface KnowledgeSeedItem {
  kind: string;
  key: string;
  title: string;
  content: string;
  source: string;
  licensed: boolean;
}

export const KNOWLEDGE_SEED_ITEMS: KnowledgeSeedItem[] = [];
