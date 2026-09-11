import { basename, resolve } from 'node:path';

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { AiDispatchService } from '../ai-dispatch/ai-dispatch.service';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import {
  ASSET_BATCH_MAX_FILES,
  ASSET_IMAGE_MIME,
  ASSET_VIDEO_MIME,
  ASSET_VIDEO_MAX_BYTES,
} from './asset.constants';
import { AssetService } from './asset.service';
import {
  BatchLicensedDto,
  BatchUploadMetaDto,
  ListAssetsQueryDto,
  UpdateAssetDto,
  UploadAssetDto,
} from './dto/asset.dto';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** 批量上传 MIME 白名单拒收清单（fileFilter 挂载，控制器并入 failed 报告，v1.5 T11） */
      assetRejectedFiles?: Array<{ name: string; reason: string }>;
    }
  }
}

/** 素材上传限制（V2.3b，沿 P5-04 photos 模式）：≤10MB，jpg/png/webp/pdf（产品资料常为 PDF）。
 * 默认内存存储（单店低并发），落盘由服务层统一处理。 */
const ASSET_UPLOAD_OPTIONS = {
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (
    _req: Express.Request,
    file: Express.Multer.File,
    cb: (err: Error | null, acceptFile: boolean) => void,
  ) => {
    if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.mimetype)) {
      cb(new BadRequestException('仅支持 jpg/png/webp 图片与 pdf 文档'), false);
      return;
    }
    cb(null, true);
  },
};

/** 批量上传限制（v1.5 T11）：multer 层按视频上限 1GB 收口（图片 20MB 由服务层按文件报告 failed）；
 * MIME 白名单外文件静默拒收并挂到 req.assetRejectedFiles，由报告汇总而不是中断整批。 */
const BATCH_UPLOAD_OPTIONS = {
  limits: { fileSize: ASSET_VIDEO_MAX_BYTES },
  fileFilter: (
    req: Request,
    file: Express.Multer.File,
    cb: (err: Error | null, acceptFile: boolean) => void,
  ) => {
    if (ASSET_IMAGE_MIME.test(file.mimetype) || ASSET_VIDEO_MIME.test(file.mimetype)) {
      cb(null, true);
      return;
    }
    (req.assetRejectedFiles ??= []).push({ name: file.originalname, reason: '不支持的文件类型' });
    cb(null, false);
  },
};

/** 素材库端点（M06，V2.3b；v1.5 T11 批量/编辑/缩略图）：上传/管理检索/文件服务。
 * 上传（含批量）与编辑：m06:edit ∪ m06:approve（店长/记录员编辑，老板审批位亦可发起）；
 * 查看与文件服务：m06:view（销售可检索取用，不可上传）。
 * 文件服务路径取自库不取参数（安全边界），sendFile 自动推断 Content-Type。 */
@Controller('assets')
export class AssetController {
  constructor(
    private readonly svc: AssetService,
    private readonly dispatch: AiDispatchService,
  ) {}

  /** 上传（POST /assets）——multipart 字段名 file，元数据为文本字段；重复内容 409 */
  @Post()
  @RequirePermission('m06:edit', 'm06:approve')
  @UseInterceptors(FileInterceptor('file', ASSET_UPLOAD_OPTIONS))
  @HttpCode(HttpStatus.CREATED)
  upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadAssetDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    if (!file) {
      throw new BadRequestException('素材文件不能为空');
    }
    return this.svc.upload(actor, dto, file);
  }

  /** 批量上传（POST /assets/batch，v1.5 T11）——multipart 字段名 files，≤50 个；
   * 不抛错，逐文件汇总 {created, skippedDuplicate, failed} */
  @Post('batch')
  @RequirePermission('m06:edit', 'm06:approve')
  @UseInterceptors(FilesInterceptor('files', ASSET_BATCH_MAX_FILES, BATCH_UPLOAD_OPTIONS))
  @HttpCode(HttpStatus.CREATED)
  uploadBatch(
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() dto: BatchUploadMetaDto,
    @Req() req: Request,
    @CurrentUser() actor: JwtPayload,
  ) {
    const rejected = req.assetRejectedFiles ?? [];
    const accepted = files ?? [];
    if (accepted.length === 0 && rejected.length === 0) {
      throw new BadRequestException('素材文件不能为空');
    }
    return this.svc.uploadBatch(actor, dto, accepted, rejected);
  }

  /** 列表（GET /assets?kind=&keyword=） */
  @Get()
  @RequirePermission('m06:view')
  list(@Query() query: ListAssetsQueryDto) {
    return this.svc.list(query);
  }

  /** 文件服务（GET /assets/:id/file）——鉴权后输出本地文件；@Res 直控响应流 */
  @Get(':id/file')
  @RequirePermission('m06:view')
  async file(@Param('id') id: string, @Res() res: Response) {
    const asset = await this.svc.getById(id);
    if (!asset) throw new AppException(ErrorCode.NOT_FOUND, '素材不存在');
    res.sendFile(resolve(asset.filePath), (err) => {
      if (err && !res.headersSent) {
        res.status(HttpStatus.NOT_FOUND).json({ code: 'NOT_FOUND', message: '素材文件缺失' });
      }
    });
  }

  /** 缩略图（GET /assets/:id/thumb，v1.5 T11）——有缩略图返回 webp，否则回退原文件 */
  @Get(':id/thumb')
  @RequirePermission('m06:view')
  async thumb(@Param('id') id: string, @Res() res: Response) {
    const { filePath } = await this.svc.getThumb(id);
    res.sendFile(resolve(filePath), (err) => {
      if (err && !res.headersSent) {
        res.status(HttpStatus.NOT_FOUND).json({ code: 'NOT_FOUND', message: '缩略图文件缺失' });
      }
    });
  }

  /** 详情（GET /assets/:id） */
  @Get(':id')
  @RequirePermission('m06:view')
  async get(@Param('id') id: string) {
    const asset = await this.svc.getById(id);
    if (!asset) throw new AppException(ErrorCode.NOT_FOUND, '素材不存在');
    return asset;
  }

  /** 批量授权（PATCH /assets/batch，2026-08-25 老板反馈）——一键标记所选授权/内部。
   * 字面量路由必须声明在 @Patch(':id') 之前（/leads/takeover 被 /leads/:id 吞掉的同款顺序坑） */
  @Patch('batch')
  @RequirePermission('m06:edit', 'm06:approve')
  updateLicensedBatch(
    @Body() dto: BatchLicensedDto,
    @CurrentUser() actor: JwtPayload,
  ): Promise<{ updated: number }> {
    return this.svc.updateLicensedBatch(actor, dto.ids, dto.licensed);
  }

  /** 编辑（PATCH /assets/:id，v1.5 T11）——tags/licensed/title/carModel/productModel/stage */
  @Patch(':id')
  @RequirePermission('m06:edit', 'm06:approve')
  update(@Param('id') id: string, @Body() dto: UpdateAssetDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.update(actor, id, dto);
  }

  /** 删除（DELETE /assets/:id，2026-08-25 老板需求）——库记录删除、文件挪回收目录 */
  @Delete(':id')
  @RequirePermission('m06:edit', 'm06:approve')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    await this.svc.remove(actor, id);
    return { deleted: true };
  }

  /** AI 标签建议（POST /assets/:id/suggest-tags，v1.5 T13）——提交 asset.suggest_tags 任务，
   * 输出为建议态标签数组（≤8 个），人工采纳后经 PATCH tags 写入；文件名取库不取参数。
   * 载荷键用 `file` 而非 fileName：脱敏器键名启发将 *name 键按人名脱敏（A04），
   * fileName 会被改写为「首字+客户」导致技能输入失真，故避开该后缀（内容级脱敏仍生效）。 */
  @Post(':id/suggest-tags')
  @RequirePermission('m06:edit')
  async suggestTags(@Param('id') id: string) {
    const asset = await this.svc.getById(id);
    if (!asset) throw new AppException(ErrorCode.NOT_FOUND, '素材不存在');
    return this.dispatch.submitTask('asset.suggest_tags', {
      file: basename(asset.filePath),
      kind: asset.kind,
      carModel: asset.carModel,
      productModel: asset.productModel,
      stage: asset.stage,
      title: asset.title,
    });
  }
}
