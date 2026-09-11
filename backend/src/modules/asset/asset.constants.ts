/** 素材类型枚举（V2.3b 唯一来源）：与前端 /assets 页下拉一致 */
export const ASSET_KIND_VALUES = ['quote_image', 'product_doc', 'process', 'finished'] as const;
export type AssetKind = (typeof ASSET_KIND_VALUES)[number];

/** 展示标签（列表/搜索节 sub 用） */
export const ASSET_KIND_LABEL: Record<AssetKind, string> = {
  quote_image: '报价图',
  product_doc: '产品资料',
  process: '施工过程',
  finished: '完工案例',
};

/** 媒体类型（v1.5 素材管线）：由 MIME 推导入库 */
export const ASSET_MEDIA_TYPES = ['image', 'video', 'document'] as const;
export type AssetMediaType = (typeof ASSET_MEDIA_TYPES)[number];

/** 批量上传 MIME 白名单（v1.5 T11）：图片 jpg/png/webp + 视频 mp4/mov(quicktime) */
export const ASSET_IMAGE_MIME = /^(image\/(jpeg|png|webp))$/;
export const ASSET_VIDEO_MIME = /^(video\/(mp4|quicktime))$/;

/** 批量上传单次文件数上限 */
export const ASSET_BATCH_MAX_FILES = 50;
/** 单文件大小上限：图片 20MB / 视频 1GB（超限在服务层按文件报告 failed，不中断整批） */
export const ASSET_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const ASSET_VIDEO_MAX_BYTES = 1024 * 1024 * 1024;

/** 缩略图边长（px）：仅图片生成，sharp resize 目标宽 */
export const ASSET_THUMB_SIZE = 256;
