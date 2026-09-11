import { http } from './http';

export interface KnowledgeItem {
  id: string;
  kind: string;
  key: string;
  title: string;
  content: string;
  version: number;
  source: string | null;
  licensed: boolean;
  expiresAt: string | null;
  status: string;
  tags: Record<string, unknown> | null;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeListParams {
  kind?: string;
  status?: string;
  keyword?: string;
}

export interface CreateKnowledgeData {
  kind: string;
  key: string;
  title: string;
  content: string;
  source?: string;
  licensed?: boolean;
  expiresAt?: string;
  tags?: Record<string, unknown>;
}

export interface UpdateKnowledgeData {
  title?: string;
  content?: string;
  source?: string;
  licensed?: boolean;
  expiresAt?: string | null;
  tags?: Record<string, unknown>;
}

export interface KnowledgeSearchResult {
  /** 知识条目 ID（首页助手「查看原文」依赖） */
  itemId: string;
  chunkText: string;
  itemTitle: string;
  kind: string;
  source: string | null;
  licensed: boolean;
  version: number;
  similarity: number;
}

/** 命中素材引用（V2.3b）：仅 licensed=true 素材可被检索引用（后端过滤） */
export interface KnowledgeAssetRef {
  id: string;
  title: string;
  kind: string;
  carModel: string | null;
  licensed: boolean;
}

export interface KnowledgeSearchResponse {
  query: string;
  results: KnowledgeSearchResult[];
  /** 命中素材引用（V2.3b 追加，仅授权素材；旧消费方可忽略） */
  assets?: KnowledgeAssetRef[];
  answer: string;
  confidence: string;
  uncertainReason: string | null;
}

/** 知识源文件内容（GET /knowledge/source-file，#14）：仓库 `门店知识源/` 内 .md 只读 */
export interface KnowledgeSourceFile {
  path: string;
  content: string;
}

/** 从知识条目 source 字符串提取可跳转的知识源文件路径（门店知识源/ 前缀 .md；
 * 兼容「路径 + 口径备注」等带后缀的写法，提取不到返回 null） */
export const extractKnowledgeSourcePath = (source?: string | null): string | null => {
  const m = source?.match(/^门店知识源\/[^\s]*?\.md/);
  return m ? m[0] : null;
};

export const knowledgeApi = {
  list(params?: KnowledgeListParams) {
    return http.get<KnowledgeItem[]>('/knowledge', { params }).then((r) => r.data);
  },

  get(id: string) {
    return http.get<KnowledgeItem>(`/knowledge/${id}`).then((r) => r.data);
  },

  create(data: CreateKnowledgeData) {
    return http.post<KnowledgeItem>('/knowledge', data).then((r) => r.data);
  },

  update(id: string, data: UpdateKnowledgeData) {
    return http.patch<KnowledgeItem>(`/knowledge/${id}`, data).then((r) => r.data);
  },

  activate(id: string) {
    return http
      .post<KnowledgeItem | { approvalId: string }>(`/knowledge/${id}/activate`)
      .then((r) => r.data);
  },

  expire(id: string) {
    return http.post<KnowledgeItem>(`/knowledge/${id}/expire`).then((r) => r.data);
  },

  versions(id: string) {
    return http.get<KnowledgeItem[]>(`/knowledge/${id}/versions`).then((r) => r.data);
  },

  search(query: string) {
    // 真实模型链路实测 4-30s，须覆盖全局 15s 超时（2026-08-19 助手检索失败根因）
    return http
      .post<KnowledgeSearchResponse>('/knowledge/search', { query }, { timeout: 60_000 })
      .then((r) => r.data);
  },

  /** 知识源文件只读（#14）：path 须为 门店知识源/ 前缀 .md（后端白名单校验） */
  sourceFile(path: string) {
    return http
      .get<KnowledgeSourceFile>('/knowledge/source-file', { params: { path } })
      .then((r) => r.data);
  },
};
