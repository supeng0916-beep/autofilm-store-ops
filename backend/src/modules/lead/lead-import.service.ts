import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Lead, Prisma } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../auth/auth.types';
import { LeadSummaryTrigger } from './ai/lead-summary.trigger';
import { LeadClassifyTrigger } from './ai/lead-classify.trigger';
import { withLlmCap } from './ai/trigger-cap.util';
import { AssignService, isWalkInLead } from './assign.service';
import { DISPATCH_PARSER_VERSION, LEAD_EVENT_KIND } from './lead.constants';
import { DedupService } from './dedup.service';
import { KeyedLock } from './import-lock';
import { normalizePhone, normalizeWechat } from './lead.normalize';
import { LeadRepository } from './lead.repository';
import {
  ParsedDispatchSchema,
  parseDispatchText,
  type ParsedDispatch,
} from './import/dispatch-parser';
import { detectExt, parseImportFile, type ImportFileExt } from './import/file-parser';
import { ImportRowSchema, SOURCE_CATEGORY_MAP, type ImportRow } from './import/row-schema';

/** 错误行（返回客户端）：物理行号（表头=1，数据自 2 起）+ 校验消息。
 * 不含原始数据：chatLink 等敏感列只落库/供服务端导出，不进 JSON 返回。 */
export interface ImportErrorRow {
  row: number;
  message: string;
}

/** 错误行（服务端内部）：附带原始（已映射）数据，仅供 xlsx 导出使用，绝不直接序列化返回 */
export interface ImportErrorDetail extends ImportErrorRow {
  data: Record<string, string | undefined>;
}

export interface PreviewResult {
  previewToken: string;
  rowCount: number;
  errorRows: ImportErrorRow[];
}

export interface ConfirmResult {
  batchId: string;
  created: number;
  dupCount: number;
  errors: ImportErrorRow[];
}

export interface DispatchConfirmResult {
  batchId: string;
  created: number;
  warningCount: number;
  dupCount: number;
  errors: ImportErrorRow[];
}

interface PreviewEntry {
  rows: ImportRow[];
  fileName: string;
  fileHash: string;
  kind: ImportFileExt;
  expireAt: number;
  errors: ImportErrorDetail[];
}

/** 预览暂存 TTL：10 分钟（服务端内存 Map，V1 单机部署足够） */
const PREVIEW_TTL_MS = 10 * 60 * 1000;

/** 客资导入管线：两阶段预览→确认；行级校验错误行不阻断；文件指纹查重。
 * chatLink 只落库，不进日志/审计/返回值（角色过滤留待 Task 7）。 */
@Injectable()
export class LeadImportService {
  private readonly logger = new Logger(LeadImportService.name);

  private readonly previews = new Map<string, PreviewEntry>();

  /** 去重临界区进程内互斥（V1 单机单进程）：同归一化联系方式串行，关闭并发重复落库竞态。 */
  private readonly lock = new KeyedLock();

  /** 测试注入点：进入去重临界区（已持锁、事务开始前）时调用；生产恒为空。
   * 供并发时序测试用同步屏障确定性验证互斥生效。 */
  onCriticalSectionEnter?: () => Promise<void> | void;

  /** 测试注入点：导入事务提交后、触发摘要前调用；生产恒为空。
   * 供「摘要触发发生在事务提交后」的时序断言用（P3-05 fix round 1）。 */
  onPostCommit?: () => Promise<void> | void;

  constructor(
    private readonly repo: LeadRepository,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    private readonly dedup: DedupService,
    private readonly assign: AssignService,
    private readonly summary: LeadSummaryTrigger,
    private readonly classify: LeadClassifyTrigger,
  ) {}

  /** 阶段一：解析文件、逐行校验、文件指纹查重；暂存内存并下发 previewToken */
  async preview(file: Express.Multer.File): Promise<PreviewResult> {
    const kind = detectExt(file.originalname);
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');

    const dup = await this.repo.findBatchByHash(fileHash);
    if (dup) {
      throw new AppException(ErrorCode.LEAD_DUP_BATCH, '该文件已导入过，请勿重复提交');
    }

    const { rows: rawRows } = await parseImportFile(file.buffer, kind);
    const validRows: ImportRow[] = [];
    const errors: ImportErrorDetail[] = [];
    rawRows.forEach((raw, i) => {
      const parsed = ImportRowSchema.safeParse(raw);
      if (parsed.success) {
        validRows.push(parsed.data);
      } else {
        errors.push({ row: i + 2, message: flattenIssues(parsed.error), data: raw });
      }
    });

    const previewToken = randomUUID();
    this.previews.set(previewToken, {
      rows: validRows,
      fileName: file.originalname,
      fileHash,
      kind,
      expireAt: Date.now() + PREVIEW_TTL_MS,
      errors,
    });
    // 返回客户端仅 {row, message}：原始数据（含 chatLink）只留在服务端 Map 供 xlsx 导出
    return { previewToken, rowCount: validRows.length, errorRows: errors.map(toPublicErrorRow) };
  }

  /** 阶段二：单事务写 ImportBatch + 逐行 Lead + imported 事件 + 去重挂链，成功后删暂存并审计。
   * 事务整体置于去重临界区互斥锁内（按归一化联系方式 key），关闭并发同联系方式重复落库竞态。 */
  async confirm(actor: JwtPayload, previewToken: string): Promise<ConfirmResult> {
    const preview = this.getPreview(previewToken);

    const assignedLeadIds: string[] = [];
    const { batchId, created, dupCount } = await this.lock.runAll(
      this.contactKeys(preview.rows),
      async () => {
        await this.onCriticalSectionEnter?.();
        return this.prisma.$transaction(async (tx) => {
          const batch = await this.repo.createBatch(
            {
              kind: preview.kind,
              fileName: preview.fileName,
              fileHash: preview.fileHash,
              rowCount: preview.rows.length + preview.errors.length,
              dupCount: 0,
              operatorId: actor.sub,
              summary: {
                validCount: preview.rows.length,
                errorCount: preview.errors.length,
                dupCount: 0,
              },
            },
            tx,
          );
          let count = 0;
          let dups = 0;
          for (const row of preview.rows) {
            const lead = await this.repo.create(this.toLeadData(row, batch.id), tx);
            await this.repo.appendEvent(
              lead.id,
              LEAD_EVENT_KIND.IMPORTED,
              { batchId: batch.id },
              actor.sub,
              tx,
            );
            if (await this.dedup.linkAndUnify(lead, actor.sub, tx)) dups += 1;
            const ownerUserId = await this.routeAfterCreate(lead, actor.sub, tx);
            if (ownerUserId) assignedLeadIds.push(lead.id);
            count += 1;
          }
          await this.repo.updateBatchDupCount(batch.id, dups, tx);
          return { batchId: batch.id, created: count, dupCount: dups };
        });
      },
    );

    // P3-05 fix round 1：摘要触发移出事务——commit 之后逐个触发，避免同步网关往返长期持有导入事务。
    await this.onPostCommit?.();
    await withLlmCap(this.triggerSummaries(assignedLeadIds));

    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'lead.import.confirmed',
      objectType: 'import_batch',
      objectId: batchId,
      after: {
        fileName: preview.fileName,
        created,
        errorCount: preview.errors.length,
        dupCount,
      },
    });
    this.previews.delete(previewToken);

    return { batchId, created, dupCount, errors: preview.errors.map(toPublicErrorRow) };
  }

  /** 派发文本直接落库：逐条解析→schema 校验→warnings 汇总→建批次→每条文建 Lead＋dispatch_parsed 事件＋去重挂链。
   * 校验失败（缺必填）计错误行不阻断；原文与解析器版本落 Lead 留痕（D-P3-9）。 */
  async confirmDispatch(actor: JwtPayload, rawTexts: string[]): Promise<DispatchConfirmResult> {
    const valid: { fields: ParsedDispatch; raw: string }[] = [];
    const errors: ImportErrorRow[] = [];
    let warningCount = 0;

    rawTexts.forEach((raw, i) => {
      const { fields, warnings } = parseDispatchText(raw);
      warningCount += warnings.length;
      const parsed = ParsedDispatchSchema.safeParse(fields);
      if (parsed.success) {
        valid.push({ fields: parsed.data, raw });
      } else {
        errors.push({ row: i + 1, message: flattenIssues(parsed.error) });
      }
    });

    const fileHash = createHash('sha256').update(rawTexts.join('\n')).digest('hex');
    const assignedLeadIds: string[] = [];
    const { batchId, created, dupCount } = await this.lock.runAll(
      this.contactKeys(valid.map((v) => v.fields)),
      async () => {
        await this.onCriticalSectionEnter?.();
        return this.prisma.$transaction(async (tx) => {
          const batch = await this.repo.createBatch(
            {
              kind: 'dispatch_text',
              fileName: 'dispatch-text',
              fileHash,
              rowCount: rawTexts.length,
              dupCount: 0,
              operatorId: actor.sub,
              summary: {
                validCount: valid.length,
                errorCount: errors.length,
                warningCount,
                dupCount: 0,
              },
            },
            tx,
          );
          let count = 0;
          let dups = 0;
          for (const { fields, raw } of valid) {
            const lead = await this.repo.create(this.toDispatchLeadData(fields, raw, batch.id), tx);
            await this.repo.appendEvent(
              lead.id,
              LEAD_EVENT_KIND.DISPATCH_PARSED,
              { batchId: batch.id },
              actor.sub,
              tx,
            );
            if (await this.dedup.linkAndUnify(lead, actor.sub, tx)) dups += 1;
            const ownerUserId = await this.routeAfterCreate(lead, actor.sub, tx);
            if (ownerUserId) assignedLeadIds.push(lead.id);
            count += 1;
          }
          await this.repo.updateBatchDupCount(batch.id, dups, tx);
          return { batchId: batch.id, created: count, dupCount: dups };
        });
      },
    );

    // P3-05 fix round 1：摘要触发移出事务——commit 之后逐个触发。
    await this.onPostCommit?.();
    await withLlmCap(this.triggerSummaries(assignedLeadIds));

    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'lead.import.dispatch',
      objectType: 'import_batch',
      objectId: batchId,
      after: { created, errorCount: errors.length, warningCount, dupCount },
    });

    return { batchId, created, warningCount, dupCount, errors };
  }

  /** 取暂存错误行（含原始数据，仅供 xlsx 导出；校验 token 存在与 TTL，失效/过期 → 422） */
  getErrorRows(previewToken: string): ImportErrorDetail[] {
    return this.getPreview(previewToken).errors;
  }

  /** 取暂存预览（校验 token 存在与 10 分钟 TTL；失效/过期 → 422） */
  private getPreview(previewToken: string): PreviewEntry {
    const entry = this.previews.get(previewToken);
    if (!entry) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, '预览不存在或已失效，请重新上传');
    }
    if (Date.now() > entry.expireAt) {
      this.previews.delete(previewToken);
      throw new AppException(ErrorCode.VALIDATION_FAILED, '预览已过期，请重新上传');
    }
    return entry;
  }

  /** 归一化联系方式 key 集合（去重键口径：电话或微信任一命中即判重，故两类 key 都要上锁）。
   * 用于去重临界区互斥：并发同联系方式导入按同 key 串行。 */
  private contactKeys(rows: { phone?: string | null; wechat?: string | null }[]): string[] {
    const keys: string[] = [];
    for (const r of rows) {
      if (r.phone) keys.push(normalizePhone(r.phone));
      if (r.wechat) keys.push(normalizeWechat(r.wechat));
    }
    return keys;
  }

  /** 入库后自动分配（P3-03）：到店类跳过（等接待人认领）；分配失败不阻断导入，
   * owner 留空＋事件 reason='未分配待兜底'（Task 8 队列高亮）。
   * 返回最终 ownerUserId（null=未分配，供调用方决定是否触发摘要）。 */
  private async routeAfterCreate(
    lead: Lead,
    operatorId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    if (
      isWalkInLead({
        sourcePlatform: lead.sourcePlatform,
        acquisitionMethod: lead.acquisitionMethod,
      })
    ) {
      return null;
    }
    let ownerUserId: string | null = null;
    try {
      const result = await this.assign.route(lead, tx);
      ownerUserId = result.ownerUserId;
    } catch (err) {
      ownerUserId = null;
      // 分配异常不阻断导入，但必须可观测：只记 leadId/leadNo 与脱敏错误摘要（不含联系方式，S04）
      this.logger.warn(
        `客资 ${lead.leadNo}(${lead.id}) 自动分配失败，留空待兜底：${safeErrorText(err)}`,
      );
    }
    if (!ownerUserId) {
      await this.repo.appendEvent(
        lead.id,
        LEAD_EVENT_KIND.ASSIGNED,
        { reason: '未分配待兜底' },
        operatorId,
        tx,
      );
    }
    return ownerUserId;
  }

  /** 事务提交后逐个触发 AI 摘要与首次意向分级（P3-05 fix round 1 + 2026-08-26 O8 评测缺口）：
   * 重读 fresh lead（含去重路径写回的 customerId，保证 refId 走 customerRef 映射）；
   * 触发失败只记 warn 不阻断导入。 */
  private async triggerSummaries(leadIds: string[]): Promise<void> {
    for (const leadId of leadIds) {
      try {
        const fresh = await this.repo.findById(leadId);
        if (fresh) await this.summary.onAssigned(fresh);
      } catch (err) {
        this.logger.warn(`客资 ${leadId} 摘要触发失败：${safeErrorText(err)}`);
      }
      try {
        const fresh = await this.repo.findById(leadId);
        if (fresh) await this.classify.onAssigned(fresh);
      } catch (err) {
        this.logger.warn(`客资 ${leadId} 意向分级触发失败：${safeErrorText(err)}`);
      }
    }
  }

  /** 行 → Lead 落库字段：来源大类中文转英文；businessType/wechatType 直接取枚举值 */
  private toLeadData(
    row: ImportRow,
    batchId: string,
  ): Omit<Prisma.LeadUncheckedCreateInput, 'leadNo'> {
    return {
      batchId,
      sourceCategory: SOURCE_CATEGORY_MAP[row.sourceCategory],
      sourcePlatform: row.sourcePlatform,
      operatorEntity: row.operatorEntity,
      acquisitionMethod: row.acquisitionMethod,
      upstreamDispatchNo: row.upstreamDispatchNo,
      adPlanText: row.adPlanText,
      contentId: row.contentId,
      chatLink: row.chatLink,
      customerName: row.customerName,
      phone: row.phone,
      wechat: row.wechat,
      wechatType: row.wechatType,
      businessType: row.businessType,
      target: row.target,
      productNeed: row.productNeed,
      rawNeed: row.rawNeed,
      remark: row.remark,
      gender: row.gender,
      ageBand: row.ageBand,
      industry: row.industry,
      district: row.district,
      purchaseDealer: row.purchaseDealer,
      receivedAt: new Date(),
    };
  }

  /** 派发解析产物 → Lead 落库字段：原文留痕；virtual_ewm 写扫码添加下一步（不得当真实微信号） */
  private toDispatchLeadData(
    d: ParsedDispatch,
    raw: string,
    batchId: string,
  ): Omit<Prisma.LeadUncheckedCreateInput, 'leadNo'> {
    return {
      batchId,
      sourceCategory: d.sourceCategory,
      sourcePlatform: d.sourcePlatform,
      acquisitionMethod: d.acquisitionMethod,
      upstreamDispatchNo: d.upstreamDispatchNo,
      adPlanText: d.adPlanText,
      chatLink: d.chatLink,
      phone: d.phone,
      wechat: d.wechat,
      wechatType: d.wechatType ?? 'unknown',
      target: d.target,
      productNeed: d.productNeed,
      rawNeed: d.rawNeed,
      upstreamDispatchAt: d.upstreamDispatchAt,
      receivedAt: new Date(),
      dispatchRawText: raw,
      dispatchParserVersion: DISPATCH_PARSER_VERSION,
      nextStep: d.wechatType === 'virtual_ewm' ? '打开上游聊天内容扫码添加客户微信' : undefined,
    };
  }
}

/** Zod 错误扁平化为可读消息（多 issue 以「；」拼接） */
function flattenIssues(error: { issues: { message: string }[] }): string {
  return error.issues.map((i) => i.message).join('；');
}

/** 内部错误行 → 客户端错误行：剥掉 data（含 chatLink），只保留行号与消息 */
function toPublicErrorRow(detail: ImportErrorDetail): ImportErrorRow {
  return { row: detail.row, message: detail.message };
}

/** 错误摘要脱敏：截断并把 5 位以上连续数字打码，防联系方式/凭证泄漏进日志（S04） */
function safeErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/\d{5,}/g, (m) => '*'.repeat(m.length)).slice(0, 200);
}
