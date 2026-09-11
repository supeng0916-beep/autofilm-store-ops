import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { MarketingService } from './marketing.service';
// 注意：DTO 必须值导入（非 import type）——ZodValidationPipe 经 paramtypes 元数据定位
// zod schema，type-only 导入会让校验被静默跳过（裸 body 直达 service）
import {
  CreateVideoInspirationDto,
  InspirationDissectDto,
  ListVideoInspirationsQueryDto,
  UpdateVideoInspirationDto,
} from './dto/video-inspiration.dto';
import { VideoInspirationService } from './video-inspiration.service';

/** 灵感库端点（M02 批次B）：爆款参考数据沉淀——人工录入拆解（钩子/结构/节奏），
 * 供运营浏览与文案生成注入参考。权限口径与既有营销端点一致：
 * 写 = m02:edit ∪ m02:approve（任一），读 = m02:view。刻意不提供 DELETE
 * （归档代替删除，参考沉淀只增与改，口径同内容台账）。
 * 批次B Task 2 增 AI 侧：dissect（粘贴原文→拆解建议预览）与 scan（联网扫描→
 * 候选预览）——两条 AI 路径都只返回建议态结果，不直接入库。 */
@Controller('marketing/video/inspirations')
export class VideoInspirationController {
  constructor(
    private readonly svc: VideoInspirationService,
    private readonly marketing: MarketingService,
  ) {}

  /** 列表（GET /marketing/video/inspirations?keyword=&platform=&isPeer=）
   * ——active 优先、archived 沉底，组内 createdAt 倒序 */
  @Get()
  @RequirePermission('m02:view')
  list(@Query() query: ListVideoInspirationsQueryDto) {
    return this.svc.list(query);
  }

  /** 录入（POST /marketing/video/inspirations）——拆解四要素必填（rhythm 可空），tags ≤6 */
  @Post()
  @RequirePermission('m02:edit', 'm02:approve')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateVideoInspirationDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.create(actor, dto);
  }

  /** AI 拆解（POST /marketing/video/inspirations/dissect，批次B Task 2）：粘贴爆款原文 →
   * 结构化拆解建议（钩子/结构/节奏/标签 + 借鉴点）——预览态返回不入库，
   * 人工确认（可改）后走创建端点录入 */
  @Post('dissect')
  @RequirePermission('m02:edit', 'm02:approve')
  @HttpCode(HttpStatus.OK)
  dissect(@Body() dto: InspirationDissectDto, @CurrentUser() actor: JwtPayload) {
    return this.marketing.dissectInspiration(actor, dto);
  }

  /** 周期扫描手动版（POST /marketing/video/inspirations/scan，批次B Task 2）：联网搜
   * 近一周贴膜/汽车后市场爆款公开分析 → 候选预览数组（不入库），前端确认后逐条录入 */
  @Post('scan')
  @RequirePermission('m02:edit', 'm02:approve')
  @HttpCode(HttpStatus.OK)
  scan(@CurrentUser() actor: JwtPayload) {
    return this.marketing.scanInspirations(actor);
  }

  /** 更新（PATCH /marketing/video/inspirations/:id）——仅 note/status/tags 可改 */
  @Patch(':id')
  @RequirePermission('m02:edit', 'm02:approve')
  @HttpCode(HttpStatus.OK)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateVideoInspirationDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.svc.update(actor, id, dto);
  }

  /** 采纳候选（POST /marketing/video/inspirations/:id/adopt，T4 自动扫描配套）：
   * candidate → active——自动扫描落的候选经人点头转正式（参与 AI 上下文注入）。
   * 权限 m02:edit（设计裁定：采纳是对建议的判断动作，比普通编辑面窄）；仅 candidate
   * 可操作，其余状态 409（终态防重口径同回访/受理先例） */
  @Post(':id/adopt')
  @RequirePermission('m02:edit')
  @HttpCode(HttpStatus.OK)
  adopt(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.svc.adoptCandidate(actor, id);
  }

  /** 忽略候选（POST /marketing/video/inspirations/:id/dismiss）：candidate → archived
   * ——不采纳也不留待办，归档保留可翻查；口径与 adopt 同（m02:edit、仅 candidate） */
  @Post(':id/dismiss')
  @RequirePermission('m02:edit')
  @HttpCode(HttpStatus.OK)
  dismiss(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.svc.dismissCandidate(actor, id);
  }
}
