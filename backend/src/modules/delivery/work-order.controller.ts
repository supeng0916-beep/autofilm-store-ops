import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { WorkOrderService } from './work-order.service';
import {
  AddAbnormalDto,
  CareNotesConfirmDto,
  CaseRequestDto,
  CreateWorkOrderDto,
  DeliverDto,
  ListWorkOrdersQueryDto,
  PhotoNoteDto,
  ReworkDto,
  StageActionDto,
} from './dto/work-order.dto';

/** 照片上传限制（P5-04，2026-08-17 复核改 multipart）：≤10MB，仅 jpg/png/webp。
 * 默认内存存储（单店低并发，容量可控），落盘由服务层统一处理。 */
const PHOTO_UPLOAD_OPTIONS = {
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (
    _req: Express.Request,
    file: Express.Multer.File,
    cb: (err: Error | null, acceptFile: boolean) => void,
  ) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype)) {
      cb(new BadRequestException('仅支持 jpg/png/webp 图片'), false);
      return;
    }
    cb(null, true);
  },
};

/** 施工单端点（M08，P5-04~06）。
 * 录入/入场/自检/照片/异常：m08:edit（施工记录员）；
 * 复检/返工/交付/养护说明确认：m08:approve（店长）；案例授权回流：m06:edit（店长/记录员）。
 * 任何阶段迁移都是真人操作（S11/A02：AI 无判定合格路径）。 */
@Controller('work-orders')
export class WorkOrderController {
  constructor(private readonly svc: WorkOrderService) {}

  /** 创建（POST /work-orders）——预约须已店长确认 */
  @Post()
  @RequirePermission('m08:edit')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateWorkOrderDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.create(actor, dto);
  }

  /** 列表（GET /work-orders?stage=）——销售仅本人客资（服务层过滤） */
  @Get()
  @RequirePermission('m08:view')
  list(@Query() query: ListWorkOrdersQueryDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.list(actor, query);
  }

  /** 详情（GET /work-orders/:id）——销售仅本人客资（服务层范围约束） */
  @Get(':id')
  @RequirePermission('m08:view')
  get(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.svc.get(id, actor);
  }

  /** 入场开工（POST /work-orders/:id/start） */
  @Post(':id/start')
  @RequirePermission('m08:edit')
  @HttpCode(HttpStatus.OK)
  start(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.svc.start(actor, id);
  }

  /** 技师自检完成（POST /work-orders/:id/self-check）——记录员代录 */
  @Post(':id/self-check')
  @RequirePermission('m08:edit')
  @HttpCode(HttpStatus.OK)
  selfCheck(
    @Param('id') id: string,
    @Body() dto: StageActionDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.svc.selfCheck(actor, id, dto);
  }

  /** 店长复检（POST /work-orders/:id/recheck） */
  @Post(':id/recheck')
  @RequirePermission('m08:approve')
  @HttpCode(HttpStatus.OK)
  recheck(@Param('id') id: string, @Body() dto: StageActionDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.recheck(actor, id, dto);
  }

  /** 返工（POST /work-orders/:id/rework） */
  @Post(':id/rework')
  @RequirePermission('m08:approve')
  @HttpCode(HttpStatus.OK)
  rework(@Param('id') id: string, @Body() dto: ReworkDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.rework(actor, id, dto);
  }

  /** 客户交付（POST /work-orders/:id/deliver） */
  @Post(':id/deliver')
  @RequirePermission('m08:approve')
  @HttpCode(HttpStatus.OK)
  deliver(@Param('id') id: string, @Body() dto: DeliverDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.deliver(actor, id, dto);
  }

  /** 照片（POST /work-orders/:id/photos）——multipart 字段名 file，note 为可选文本字段 */
  @Post(':id/photos')
  @RequirePermission('m08:edit')
  @UseInterceptors(FileInterceptor('file', PHOTO_UPLOAD_OPTIONS))
  @HttpCode(HttpStatus.OK)
  addPhoto(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: PhotoNoteDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    if (!file) {
      throw new BadRequestException('照片文件不能为空');
    }
    return this.svc.addPhoto(actor, id, file, dto.note);
  }

  /** 异常记录（POST /work-orders/:id/abnormal） */
  @Post(':id/abnormal')
  @RequirePermission('m08:edit')
  @HttpCode(HttpStatus.OK)
  addAbnormal(
    @Param('id') id: string,
    @Body() dto: AddAbnormalDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.svc.addAbnormal(actor, id, dto);
  }

  /** 养护说明草稿（GET /work-orders/:id/care-notes/draft）——知识库确定性拼装 */
  @Get(':id/care-notes/draft')
  @RequirePermission('m08:view')
  draftCareNotes(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.svc.draftCareNotes(actor, id);
  }

  /** 养护说明人工确认（POST /work-orders/:id/care-notes/confirm） */
  @Post(':id/care-notes/confirm')
  @RequirePermission('m08:approve')
  @HttpCode(HttpStatus.OK)
  confirmCareNotes(
    @Param('id') id: string,
    @Body() dto: CareNotesConfirmDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.svc.confirmCareNotes(actor, id, dto);
  }

  /** 案例授权询问（POST /work-orders/:id/case-request） */
  @Post(':id/case-request')
  @RequirePermission('m06:edit')
  @HttpCode(HttpStatus.OK)
  caseRequest(
    @Param('id') id: string,
    @Body() dto: CaseRequestDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.svc.caseRequest(actor, id, dto);
  }
}
