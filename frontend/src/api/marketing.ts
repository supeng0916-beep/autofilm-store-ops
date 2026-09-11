import { http } from './http';

/** 经营任务中心（V2.1 首批，M02） */

export interface VideoCopyDraft {
  title: string;
  hook: string;
  script: string;
  hashtags: string[];
  sourceRefs: string[];
}

/** 账号定位（2026-09-04 短视频运营升级）：账号的"身份证"，选题筛选与脚本生成注入 */
export interface VideoPositioning {
  storePositioning: string;
  targetAudience: string;
  persona: string;
  pillars: string[];
  resources: string;
  tone: string;
}

/** 选题包（marketing.video_topic 产出）：3~5 个选题建议，纯建议态由人挑选 */
export interface VideoTopic {
  title: string;
  angle: string;
  reason: string;
  hookDirection: string;
  structure: string;
  difficulty: '低' | '中' | '高';
  type: 'hot' | 'evergreen';
  source: string | null;
}

export interface CompetitorNotesResult {
  notes: {
    summary: string;
    points: Array<{ kind: string; content: string }>;
    caution: string | null;
  };
  knowledgeItemId: string;
}

/** 选题上下文：从选题包带入脚本生成，按其钩子方向/参考结构创作 */
export interface TopicContext {
  angle?: string;
  reason?: string;
  hookDirection?: string;
  structure?: string;
  type?: 'hot' | 'evergreen';
  source?: string;
}

export const marketingApi = {
  videoCopy: (data: {
    topic: string;
    productModel?: string;
    carModel?: string;
    style?: string;
    durationSec?: number;
    topicContext?: TopicContext;
  }) =>
    http
      .post<{ taskId: string; draft: VideoCopyDraft }>('/marketing/video-copy', data, {
        timeout: 180_000, // AI 任务时限 120s + 余量，覆盖全局 15s
      })
      .then((r) => r.data),
  /** 账号定位：未保存过时返回后端按门店情况拟的默认草稿 */
  getVideoPositioning: () =>
    http.get<VideoPositioning>('/marketing/video/positioning').then((r) => r.data),
  saveVideoPositioning: (data: VideoPositioning) =>
    http.put<VideoPositioning>('/marketing/video/positioning', data).then((r) => r.data),
  /** 选题包生成（联网搜索较久，deadline 180s + 余量） */
  generateVideoTopics: () =>
    http
      .post<{
        taskId: string;
        dateKey: string;
        topics: { topics: VideoTopic[]; hotNote: string | null };
      }>('/marketing/video/topics', {}, { timeout: 240_000 })
      .then((r) => r.data),
  /** 当日选题包复看：未生成过返回 null */
  getVideoTopics: () =>
    http
      .get<{ taskId: string; topics: { topics: VideoTopic[]; hotNote: string | null } } | null>(
        '/marketing/video/topics',
      )
      .then((r) => r.data),
  competitorNotes: (data: { sourceText: string; sourcePlatform?: string }) =>
    http
      .post<{ taskId: string } & CompetitorNotesResult>('/marketing/competitor-notes', data, {
        timeout: 180_000,
      })
      .then((r) => r.data),
};

/** 内容台账条目（批次2 T7）：contentKey 与客资导入的内容编号一致即可归因 */
export interface ContentRecord {
  id: string;
  contentKey: string;
  title: string;
  platform: string | null;
  publishedAt: string | null;
  costFen: number;
  viewsCount: number | null;
  likesCount: number | null;
  commentsCount: number | null;
  note: string | null;
}

export const contentRecordApi = {
  /** 台账列表（发布时间倒序） */
  list: () => http.get<ContentRecord[]>('/marketing/content-records').then((r) => r.data),

  /** 登记内容（编号唯一） */
  create: (data: {
    contentKey: string;
    title: string;
    platform?: string;
    publishedAt?: string;
    costFen?: number;
    note?: string;
  }) => http.post<ContentRecord>('/marketing/content-records', data).then((r) => r.data),

  /** 更新互动数据/投流费/备注 */
  update: (
    id: string,
    data: {
      viewsCount?: number;
      likesCount?: number;
      commentsCount?: number;
      costFen?: number;
      note?: string;
    },
  ) => http.patch<ContentRecord>(`/marketing/content-records/${id}`, data).then((r) => r.data),
};

/** 同行动态条目（批次4） */
export interface CompetitorPost {
  id: string;
  account: string;
  title: string;
  publishedAt: string | null;
  likesCount: number | null;
  commentsCount: number | null;
  sharesCount: number | null;
  activityType: string | null;
  source: string;
  crawledAt: string | null;
}

export const competitorPostApi = {
  /** 人工录入同行动态 */
  create: (data: {
    account: string;
    title: string;
    publishedAt?: string;
    likesCount?: number;
    commentsCount?: number;
    sharesCount?: number;
    activityType?: string;
    note?: string;
  }) => http.post<CompetitorPost>('/marketing/competitor-posts', data).then((r) => r.data),

  /** 近期列表（?account 过滤） */
  list: (account?: string) =>
    http
      .get<CompetitorPost[]>('/marketing/competitor-posts', { params: account ? { account } : {} })
      .then((r) => r.data),

  /** 看板对比（同行账号聚合 vs 我们） */
  board: () =>
    http
      .get<{
        competitors: Array<{
          account: string;
          posts: number;
          totalLikes: number;
          topLikes: number;
        }>;
        ours: { posts: number; totalLikes: number; topLikes: number };
      }>('/marketing/competitor-board')
      .then((r) => r.data),
};

/** 灵感库条目（M02 批次B）：爆款参考沉淀——拆解四要素是录入时的原文快照，
 * 创建后不可改（更新面仅 note/tags/status）；归档=不再注入 AI 上下文但保留可翻查；
 * candidate=每日自动扫描落的候选建议态（T4），人工采纳才转 active、忽略转 archived */
export interface VideoInspiration {
  id: string;
  platform: string;
  title: string;
  /** 钩子拆解 */
  hookText: string;
  /** 结构拆解 */
  structure: string;
  /** 节奏拆解（可空：非每条都有） */
  rhythm: string | null;
  /** 数据描述（如「50w 赞/1.2w 评」，文本非数值） */
  metrics: string | null;
  /** 内容支柱/主题标签（≤6） */
  tags: string[];
  /** 同行作品标记 */
  isPeer: boolean;
  sourceUrl: string | null;
  note: string | null;
  status: 'active' | 'archived' | 'candidate';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** AI 拆解结果（dissect，批次B Task 2）：建议态预览不入库，人工确认（可改）后走 create */
export interface InspirationDissectResult {
  hookText: string;
  structure: string;
  rhythm: string | null;
  tags: string[];
  /** 一句「我们店能借鉴什么」 */
  takeaway: string;
}

/** 扫描候选条目（scan，批次B Task 2）：联网搜近一周爆款公开分析 → 候选预览（不入库） */
export interface InspirationScanItem {
  platform: string;
  title: string;
  hookText: string;
  structure: string;
  rhythm: string | null;
  metrics: string | null;
  tags: string[];
  sourceUrl: string | null;
}

export const inspirationApi = {
  /** 列表（不筛 status 时 active 优先、候选次之、archived 沉底）：keyword 命中标题或
   * 钩子，platform 精确，isPeer 布尔；status 精确筛选（candidate=自动扫描候选，T4） */
  list: (params: { keyword?: string; platform?: string; isPeer?: boolean; status?: string } = {}) =>
    http
      .get<VideoInspiration[]>('/marketing/video/inspirations', {
        params: {
          ...(params.keyword ? { keyword: params.keyword } : {}),
          ...(params.platform ? { platform: params.platform } : {}),
          ...(params.isPeer === undefined ? {} : { isPeer: params.isPeer }),
          ...(params.status ? { status: params.status } : {}),
        },
      })
      .then((r) => r.data),

  /** 录入：platform/title/hookText/structure 必填，其余可选（tags ≤6） */
  create: (data: {
    platform: string;
    title: string;
    hookText: string;
    structure: string;
    rhythm?: string;
    metrics?: string;
    tags?: string[];
    isPeer?: boolean;
    sourceUrl?: string;
    note?: string;
  }) => http.post<VideoInspiration>('/marketing/video/inspirations', data).then((r) => r.data),

  /** 更新：仅 note/tags/status 可改（拆解字段是原文快照，改了要对不上原视频） */
  update: (id: string, data: { note?: string; status?: 'active' | 'archived'; tags?: string[] }) =>
    http.patch<VideoInspiration>(`/marketing/video/inspirations/${id}`, data).then((r) => r.data),

  /** 采纳候选（T4 自动扫描配套，m02:edit）：candidate → active——转正式参与 AI 参考；
   * 仅 candidate 可操作，其余状态后端 409 */
  adopt: (id: string) =>
    http.post<VideoInspiration>(`/marketing/video/inspirations/${id}/adopt`).then((r) => r.data),

  /** 忽略候选（m02:edit）：candidate → archived——不采纳也不留待办，保留可翻查 */
  dismiss: (id: string) =>
    http.post<VideoInspiration>(`/marketing/video/inspirations/${id}/dismiss`).then((r) => r.data),

  /** AI 拆解：粘贴爆款原文 → 结构化拆解建议（预览态，确认后走 create；时限 180s + 余量） */
  dissect: (data: { rawText: string; platform?: string; isPeer?: boolean }) =>
    http
      .post<{ taskId: string; dissect: InspirationDissectResult }>(
        '/marketing/video/inspirations/dissect',
        data,
        { timeout: 180_000 },
      )
      .then((r) => r.data),

  /** 扫描爆款文章：联网搜近一周贴膜/汽车后市场爆款公开分析 → 候选预览（时限 240s + 余量） */
  scan: () =>
    http
      .post<{ taskId: string; items: InspirationScanItem[]; scanNote: string | null }>(
        '/marketing/video/inspirations/scan',
        {},
        { timeout: 240_000 },
      )
      .then((r) => r.data),
};
