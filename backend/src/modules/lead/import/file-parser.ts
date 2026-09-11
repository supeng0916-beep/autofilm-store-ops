import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-code';
import { HEADER_MAP } from './row-schema';

export type ImportFileExt = 'csv' | 'xlsx';

export interface ParsedImportFile {
  /** 映射到字段名的数据行（不含表头），空值已归一化为 undefined */
  rows: Record<string, string | undefined>[];
}

/** 按文件名扩展名识别导入格式；不支持的类型 → 整批 LEAD_PARSE_FAILED */
export function detectExt(fileName: string): ImportFileExt {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  throw new AppException(ErrorCode.LEAD_PARSE_FAILED, '仅支持 .csv 或 .xlsx 文件');
}

/** 解析导入文件：首行表头经 HEADER_MAP 映射；未识别列名 → 整批 LEAD_PARSE_FAILED 带列名明细 */
export async function parseImportFile(
  buffer: Buffer,
  ext: ImportFileExt,
): Promise<ParsedImportFile> {
  const grid = ext === 'csv' ? parseCsv(buffer) : await parseXlsx(buffer);
  if (grid.length === 0) {
    throw new AppException(ErrorCode.LEAD_PARSE_FAILED, '文件为空，缺少表头');
  }

  const headerRow = grid[0].map((cell) => normalizeCell(cell) ?? '');
  const fields: (string | null)[] = headerRow.map((header) => HEADER_MAP[header] ?? null);
  const unrecognized = headerRow.filter((_, i) => fields[i] === null);
  if (unrecognized.length > 0) {
    throw new AppException(ErrorCode.LEAD_PARSE_FAILED, '存在无法识别的列名', {
      columns: unrecognized,
    });
  }

  const rows: Record<string, string | undefined>[] = [];
  for (let r = 1; r < grid.length; r++) {
    const raw = grid[r];
    const row: Record<string, string | undefined> = {};
    for (let c = 0; c < fields.length; c++) {
      const field = fields[c];
      if (!field) continue;
      const value = normalizeCell(raw[c]);
      if (value !== undefined) row[field] = value;
    }
    rows.push(row);
  }
  return { rows };
}

/** CSV：首行表头 + 数据行；跳过空行，列数不足补齐为空串（relax_column_count） */
function parseCsv(buffer: Buffer): string[][] {
  return parse(buffer.toString('utf8'), {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
}

/** XLSX：取首个工作表，按行收集单元格值（空单元格归一为空串） */
async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new AppException(ErrorCode.LEAD_PARSE_FAILED, 'Excel 文件不含工作表');
  }
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = (row.values as unknown[]).slice(1);
    rows.push(values.map(cellToString));
  });
  return rows;
}

/** 单元格 → 字符串：处理 exceljs 的富文本/公式结果/日期等复合类型，避免 [object Object] */
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

/** 单元格归一化：去首尾空白；空值 → undefined（供 schema 判空） */
function normalizeCell(value: unknown): string | undefined {
  const trimmed = cellToString(value).trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
