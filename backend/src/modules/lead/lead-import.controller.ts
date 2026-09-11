import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { DedupService } from './dedup.service';
import { KingsoftService } from './kingsoft.service';
import { buildErrorExportXlsx, buildTemplateXlsx, XLSX_MIME } from './import/xlsx';
import { ConfirmImportDto, DispatchImportDto, MergeLeadsDto } from './lead-import.dto';
import { LeadImportService } from './lead-import.service';

/** 客资导入端点（P3-01）：两阶段预览→确认＋错误行导出＋模板下载＋派发文本＋金山反馈表。
 * 鉴权走全局守卫 + @RequirePermission('m03:edit')。 */
@Controller('leads/import')
export class LeadImportController {
  constructor(
    private readonly imports: LeadImportService,
    private readonly kingsoftService: KingsoftService,
  ) {}

  @Post('preview')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  preview(@UploadedFile() file: Express.Multer.File) {
    return this.imports.preview(file);
  }

  @Post('confirm')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  confirm(@Body() body: ConfirmImportDto, @CurrentUser() actor: JwtPayload) {
    return this.imports.confirm(actor, body.previewToken);
  }

  @Post('dispatch')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  dispatch(@Body() body: DispatchImportDto, @CurrentUser() actor: JwtPayload) {
    return this.imports.confirmDispatch(actor, body.rawTexts);
  }

  @Post('kingsoft')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  kingsoft(@UploadedFile() file: Express.Multer.File, @CurrentUser() actor: JwtPayload) {
    return this.kingsoftService.importFile(file, actor);
  }

  @Get('error-export/:previewToken')
  @RequirePermission('m03:edit')
  @Header('Content-Type', XLSX_MIME)
  @Header('Content-Disposition', 'attachment; filename="lead-import-errors.xlsx"')
  async errorExport(@Param('previewToken') previewToken: string): Promise<Buffer> {
    return buildErrorExportXlsx(this.imports.getErrorRows(previewToken));
  }

  @Get('template.xlsx')
  @RequirePermission('m03:edit')
  @Header('Content-Type', XLSX_MIME)
  @Header('Content-Disposition', 'attachment; filename="lead-import-template.xlsx"')
  async template(): Promise<Buffer> {
    return buildTemplateXlsx();
  }
}

/** 客资合并端点（P3-02）：次要（targetLeadId）并入主要（:id），只向下，不删除任何 Lead/事件。 */
@Controller('leads')
export class LeadMergeController {
  constructor(private readonly dedup: DedupService) {}

  @Post(':id/merge')
  @RequirePermission('m03:edit')
  @HttpCode(HttpStatus.OK)
  merge(@Param('id') id: string, @Body() body: MergeLeadsDto, @CurrentUser() actor: JwtPayload) {
    return this.dedup.mergeLeads(actor, id, body.targetLeadId);
  }
}
