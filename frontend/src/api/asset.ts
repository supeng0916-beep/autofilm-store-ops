import type { AiTask } from './aiTasks';
import { http } from './http';

/** 素材类型（V2.3b 唯一口径，与 backend asset.constants.ts 同步） */
export type AssetKind = 'quote_image' | 'product_doc' | 'process' | 'finished';

/** 媒体类型（v1.5 素材管线，与 backend ASSET_MEDIA_TYPES 同步） */
export type AssetMediaType = 'image' | 'video' | 'document';

/** 展示标签（筛选下拉/卡片 tag/助手素材卡片共用） */
export const ASSET_KIND_LABEL: Record<AssetKind, string> = {
  quote_image: '报价图',
  product_doc: '产品资料',
  process: '施工过程',
  finished: '完工案例',
};

/** 素材实体（GET /assets 列表项，契约见 backend Asset 模型；v1.5 新增媒资字段） */
export interface Asset {
  id: string;
  kind: AssetKind;
  title: string;
  filePath: string;
  carModel: string | null;
  productModel: string | null;
  stage: string | null;
  technicianName: string | null;
  source: string | null;
  licensed: boolean;
  workOrderId: string | null;
  createdBy: string;
  createdAt: string;
  /** v1.5 素材管线新增字段 */
  fileHash: string | null;
  thumbPath: string | null;
  mediaType: AssetMediaType;
  /** 视频秒数（仅 video 有值） */
  duration: number | null;
  /** 已确认标签（AI 建议经人工采纳后写入） */
  tags: string[];
}

/** 批量上传报告（POST /assets/batch 201，v1.5 T11）：逐文件归类，不抛错 */
export interface BatchUploadReport {
  created: Array<{ id: string; title: string }>;
  skippedDuplicate: string[];
  failed: Array<{ name: string; reason: string }>;
}

/** 素材编辑入参（PATCH /assets/:id，v1.5 T11）：仅传字段被更新 */
export interface AssetUpdateData {
  tags?: string[];
  licensed?: boolean;
  title?: string;
  carModel?: string;
  productModel?: string;
  stage?: string;
}

export interface AssetListParams {
  kind?: string;
  keyword?: string;
}

/** 素材文件直链（GET /assets/:id/file）。
 * 注意：该端点在全局 Bearer 守卫之后，<img src>/window.open 无法携带令牌，
 * 页面内展示/打开须经 fetchFile（带 Authorization 头）取 blob URL 使用。 */
export const assetFileUrl = (id: string): string => `/api/v1/assets/${id}/file`;

export const assetApi = {
  /** 列表：kind 筛选 + keyword（后端 title/carModel ILIKE），新上传在前 */
  list(params?: AssetListParams) {
    return http.get<Asset[]>('/assets', { params }).then((r) => r.data);
  },

  /** 详情 */
  get(id: string) {
    return http.get<Asset>(`/assets/${id}`).then((r) => r.data);
  },

  /** 上传（POST /assets multipart）：file + 文本元数据字段，licensed 为字符串布尔 */
  upload(formData: FormData) {
    return http.post<Asset>('/assets', formData).then((r) => r.data);
  },

  /** 文件二进制（经 http 实例注入 Bearer；blob URL 供缩略/预览/新窗口打开） */
  fetchFile(id: string) {
    return http.get<Blob>(`/assets/${id}/file`, { responseType: 'blob' }).then((r) => r.data);
  },

  /** 缩略图二进制（GET /assets/:id/thumb，v1.5 T11）：有缩略图返回 webp，否则回退原图。
   * 与 fetchFile 同走带令牌 fetch → blob URL 模式（thumb 端点同样在 Bearer 守卫后）。 */
  fetchThumb(id: string) {
    return http.get<Blob>(`/assets/${id}/thumb`, { responseType: 'blob' }).then((r) => r.data);
  },

  /** 批量上传（POST /assets/batch multipart，v1.5 T11）：files[] + kind + carModel（本批共用，
   * 2026-08-28 起支持——网页批量上传也能按车型分组），单请求语义。
   * 后端 multer 内存存储，调用方（对话框）负责分批（≤5 文件且 ≤200MB/批）串行提交。
   * timeout 300s 防大文件超时（AI/批量专属超时先例，HANDOFF 踩坑实录）。 */
  uploadBatch(files: File[], kind: AssetKind, carModel?: string) {
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    fd.append('kind', kind);
    if (carModel) fd.append('carModel', carModel);
    return http
      .post<BatchUploadReport>('/assets/batch', fd, { timeout: 300_000 })
      .then((r) => r.data);
  },

  /** 编辑（PATCH /assets/:id，v1.5 T11）：tags/licensed/title/carModel/productModel/stage */
  update(id: string, data: AssetUpdateData) {
    return http.patch<Asset>(`/assets/${id}`, data).then((r) => r.data);
  },

  /** 批量授权（PATCH /assets/batch，2026-08-25 老板反馈）：一键将所选标记授权/内部，
   * 返回实际更新条数（≤200/批，与批量上传口径一致） */
  batchLicensed(ids: string[], licensed: boolean) {
    return http.patch<{ updated: number }>('/assets/batch', { ids, licensed }).then((r) => r.data);
  },

  /** 删除（DELETE /assets/:id，2026-08-25 老板需求）：库记录删除，
   * 物理文件由后端挪入回收目录（误删可人工找回） */
  remove(id: string) {
    return http.delete<{ deleted: true }>(`/assets/${id}`).then((r) => r.data);
  },

  /** AI 标签建议（POST /assets/:id/suggest-tags，v1.5 T13）：提交异步 ai_task 返回任务对象。
   * timeout 60s 对齐注册表 deadlineSeconds（AI 类请求专属超时先例）；
   * 完成后结果在 task.output.tags，前端经 fetchAiTaskDetail 轮询取终态。 */
  suggestTags(id: string) {
    return http
      .post<AiTask>(`/assets/${id}/suggest-tags`, {}, { timeout: 60_000 })
      .then((r) => r.data);
  },
};

/** 视频时长秒 → mm:ss（video 卡片占位展示；null/非有限/负数兜底 00:00） */
export function formatDuration(seconds: number | null): string {
  const total =
    typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
      ? Math.floor(seconds)
      : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
