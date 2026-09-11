import ExcelJS from 'exceljs';

import { HEADER_MAP, TEMPLATE_HEADERS } from './row-schema';
import type { ImportErrorDetail } from '../lead-import.service';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 导入模板：仅 17 列表头（系统生成列不在模板） */
export async function buildTemplateXlsx(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('导入模板');
  sheet.addRow([...TEMPLATE_HEADERS]);
  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}

/** 错误行导出：17 列原始数据 + 行号 + 错误信息。
 * chatLink 脱敏：本任务只落库、不回传（角色过滤 Task 7 落地前一律置空）。 */
export async function buildErrorExportXlsx(errors: ImportErrorDetail[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('错误行');
  sheet.addRow([...TEMPLATE_HEADERS, '行号', '错误信息']);
  for (const err of errors) {
    const values = TEMPLATE_HEADERS.map((header) => {
      const field = HEADER_MAP[header];
      return field === 'chatLink' ? '' : (err.data[field] ?? '');
    });
    sheet.addRow([...values, String(err.row), err.message]);
  }
  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}
