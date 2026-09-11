import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Lead } from '@prisma/client';
import ExcelJS from 'exceljs';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../auth/auth.types';
import { LEAD_EVENT_KIND } from './lead.constants';
import type { ImportErrorRow } from './lead-import.service';
import { LeadRepository } from './lead.repository';

/** 金山反馈表行（exceljs 解析产物；成交金额以元计） */
export interface KingsoftRow {
  upstreamDispatchNo?: string;
  hqFeedbackStatus?: string;
  amountYuan?: number;
}

export interface KingsoftResult {
  batchId: string;
  matched: number;
  errors: ImportErrorRow[];
}

/** 金山反馈表列名 → 字段（成交日期识别但暂不落库，见 importRows 注释） */
const KINGSOFT_HEADER_MAP: Record<string, string> = {
  派发NO: 'upstreamDispatchNo',
  总部反馈状态: 'hqFeedbackStatus',
  成交金额: 'amountYuan',
  成交日期: 'closedAtRaw',
};

/** 金山反馈表导入：按派发NO精确匹配回填 hqFeedbackStatus 与成交金额（不改 finalStatus，成交走 Task 9 人工确认） */
@Injectable()
export class KingsoftService {
  constructor(
    private readonly repo: LeadRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** multipart 入口：解析 xlsx → 逐行匹配回填 */
  async importFile(file: Express.Multer.File, operator: JwtPayload): Promise<KingsoftResult> {
    const rows = await parseKingsoftXlsx(file.buffer);
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    return this.importRows(rows, operator, file.originalname, fileHash);
  }

  async importRows(
    rows: KingsoftRow[],
    operator: JwtPayload,
    fileName = 'kingsoft.xlsx',
    fileHash = '',
  ): Promise<KingsoftResult> {
    // 1. 逐行匹配（读，不阻断）：缺派发NO / 未匹配 → 错误集
    const matched: { row: KingsoftRow; lead: Lead }[] = [];
    const errors: ImportErrorRow[] = [];
    await Promise.all(
      rows.map(async (row, i) => {
        const rowNum = i + 2; // 表头=1
        if (!row.upstreamDispatchNo) {
          errors.push({ row: rowNum, message: '缺少派发NO' });
          return;
        }
        const lead = await this.repo.findByDispatchNo(row.upstreamDispatchNo);
        if (!lead) {
          errors.push({ row: rowNum, message: `派发NO ${row.upstreamDispatchNo} 未匹配到客资` });
          return;
        }
        matched.push({ row, lead });
      }),
    );

    // 2. 事务写：建批次 + 回填 + followup_recorded 事件
    const { batchId } = await this.prisma.$transaction(async (tx) => {
      const batch = await this.repo.createBatch(
        {
          kind: 'kingsoft',
          fileName,
          fileHash,
          rowCount: rows.length,
          dupCount: 0,
          operatorId: operator.sub,
          summary: { matchedCount: matched.length, errorCount: errors.length },
        },
        tx,
      );
      for (const { row, lead } of matched) {
        const updates: { hqFeedbackStatus?: string; closedAmountFen?: number } = {};
        if (row.hqFeedbackStatus !== undefined) updates.hqFeedbackStatus = row.hqFeedbackStatus;
        // 成交金额仅回填 closedAmountFen，不改 finalStatus（成交必须走 Task 9 状态机人工确认）
        if (row.amountYuan !== undefined) updates.closedAmountFen = yuanToFen(row.amountYuan);
        if (Object.keys(updates).length > 0) {
          await this.repo.updateKingsoftFeedback(lead.id, updates, tx);
        }
        await this.repo.appendEvent(
          lead.id,
          LEAD_EVENT_KIND.FOLLOWUP_RECORDED,
          { source: 'kingsoft' },
          operator.sub,
          tx,
        );
      }
      return { batchId: batch.id };
    });

    await this.audit.record({
      actorId: operator.sub,
      actorName: operator.username,
      action: 'lead.import.kingsoft',
      objectType: 'import_batch',
      objectId: batchId,
      after: { matched: matched.length, errorCount: errors.length },
    });

    return { batchId, matched: matched.length, errors };
  }
}

/** 解析金山反馈 xlsx：首行表头经 KINGSOFT_HEADER_MAP 映射；未识别列名 → 整批 LEAD_PARSE_FAILED */
export async function parseKingsoftXlsx(buffer: Buffer): Promise<KingsoftRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new AppException(ErrorCode.LEAD_PARSE_FAILED, 'Excel 文件不含工作表');
  }

  const grid: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    grid.push((row.values as unknown[]).slice(1).map(cellToString));
  });
  if (grid.length === 0) {
    throw new AppException(ErrorCode.LEAD_PARSE_FAILED, '文件为空，缺少表头');
  }

  const headerRow = grid[0].map((c) => normalizeCell(c) ?? '');
  const fields = headerRow.map((h) => KINGSOFT_HEADER_MAP[h] ?? null);
  const unrecognized = headerRow.filter((_, i) => fields[i] === null);
  if (unrecognized.length > 0) {
    throw new AppException(ErrorCode.LEAD_PARSE_FAILED, '存在无法识别的列名', {
      columns: unrecognized,
    });
  }

  const rows: KingsoftRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const raw = grid[r];
    const row: KingsoftRow = {};
    for (let c = 0; c < fields.length; c++) {
      const field = fields[c];
      if (!field) continue;
      const value = normalizeCell(raw[c]);
      if (value === undefined) continue;
      if (field === 'upstreamDispatchNo') row.upstreamDispatchNo = value;
      else if (field === 'hqFeedbackStatus') row.hqFeedbackStatus = value;
      else if (field === 'amountYuan') {
        const n = Number(value);
        if (Number.isFinite(n)) row.amountYuan = n;
      }
      // closedAtRaw：识别但不落库（成交日期回填由 Task 9 状态机人工确认）
    }
    rows.push(row);
  }
  return rows;
}

/** 元 → 分（四舍五入，避免浮点误差） */
function yuanToFen(yuan: number): number {
  return Math.round(yuan * 100);
}

/** 单元格 → 字符串：处理 exceljs 富文本/公式结果/日期等复合类型 */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const cell = value as { text?: unknown; result?: unknown };
    if (typeof cell.text === 'string') return cell.text;
    if (cell.result !== undefined && cell.result !== null) return cellToString(cell.result);
    return '';
  }
  return '';
}

/** 单元格归一化：去首尾空白；空值 → undefined */
function normalizeCell(value: unknown): string | undefined {
  const trimmed = cellToString(value).trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
