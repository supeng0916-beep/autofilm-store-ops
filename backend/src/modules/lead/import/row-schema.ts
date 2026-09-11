import { z } from 'zod';

import { LEAD_BUSINESS_TYPES, WECHAT_TYPES } from '../lead.constants';

/** 导入行 Zod schema（字段字典 17 列导入子集；L/M 条件必填在 refine 里） */
export const ImportRowSchema = z
  .object({
    sourceCategory: z.enum(['线上', '线下']),
    sourcePlatform: z.string().min(1, '来源平台必填'),
    operatorEntity: z.string().optional(),
    acquisitionMethod: z.string().optional(),
    upstreamDispatchNo: z.string().optional(),
    adPlanText: z.string().optional(),
    contentId: z.string().optional(),
    chatLink: z.string().optional(),
    customerName: z.string().optional(),
    phone: z.string().optional(),
    wechat: z.string().optional(),
    wechatType: z.enum(WECHAT_TYPES).default('unknown'),
    businessType: z.enum(LEAD_BUSINESS_TYPES).default('auto_film'),
    target: z.string().optional(),
    productNeed: z.string().min(1, '需求产品必填'),
    rawNeed: z.string().optional(),
    remark: z.string().optional(),
    // 画像五列（批次2 T4）：全选填；性别中文枚举转英文，年龄段非空须命中分段
    gender: z
      .enum(['男', '女'])
      .optional()
      .transform((v) => (v === '男' ? 'male' : v === '女' ? 'female' : undefined)),
    ageBand: z.enum(['18-25', '26-35', '36-45', '46-55', '55+']).optional(),
    industry: z.string().trim().max(50).optional(),
    district: z.string().trim().max(50).optional(),
    purchaseDealer: z.string().trim().max(100).optional(),
  })
  .refine((r) => Boolean(r.phone || r.wechat), { message: '电话与微信至少填一项' });
export type ImportRow = z.infer<typeof ImportRowSchema>;

/** 中文表头 → 字段名（模板列序即字段字典列序子集） */
export const HEADER_MAP: Record<string, string> = {
  来源大类: 'sourceCategory',
  来源平台: 'sourcePlatform',
  运营主体: 'operatorEntity',
  获客方式: 'acquisitionMethod',
  '上游派发NO/介绍人': 'upstreamDispatchNo',
  '广告计划/活动原文': 'adPlanText',
  '内容标题/内容ID/链接': 'contentId',
  '上游聊天/原始信息链接': 'chatLink',
  客户称呼: 'customerName',
  联系电话: 'phone',
  微信号: 'wechat',
  微信号类型: 'wechatType',
  业务类型: 'businessType',
  '车型/住宅对象': 'target',
  '需求产品/服务': 'productNeed',
  客户原始需求: 'rawNeed',
  备注: 'remark',
  客户性别: 'gender',
  年龄段: 'ageBand',
  行业: 'industry',
  住所方位: 'district',
  购车门店: 'purchaseDealer',
};

/** 模板列序（与 HEADER_MAP 插入序一致，用于模板下载与错误行导出表头） */
export const TEMPLATE_HEADERS: readonly string[] = Object.keys(HEADER_MAP);

/** 来源大类中文 → DB 英文（D-P3 字段字典 C 列：只分线上/线下） */
export const SOURCE_CATEGORY_MAP: Record<string, 'online' | 'offline'> = {
  线上: 'online',
  线下: 'offline',
};
