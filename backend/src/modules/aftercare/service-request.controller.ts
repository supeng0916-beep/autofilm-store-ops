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
import {
  CreateServiceRequestDto,
  ListServiceRequestsQueryDto,
  UpdateServiceRequestDto,
} from './dto/service-request.dto';
import { ServiceRequestService } from './service-request.service';

/** 售后受理端点（M09 批次1）：四类受理（咨询/复检/投诉/其他）的列表/创建/推进。
 * 投诉创建即通知老板（服务内 safeNotify）。权限点同回访：m09:view/m09:edit
 * （PERMISSION_MATRIX：boss/店长/销售均有受理处理权，记录员无）。 */
@Controller('aftercare/service-requests')
export class ServiceRequestController {
  constructor(private readonly svc: ServiceRequestService) {}

  /** 列表（GET /aftercare/service-requests?status=&kind=）——createdAt desc，新受理在前 */
  @Get()
  @RequirePermission('m09:view')
  list(@Query() query: ListServiceRequestsQueryDto) {
    return this.svc.list(query);
  }

  /** 创建（POST /aftercare/service-requests）——投诉类落库后直通老板通知 */
  @Post()
  @RequirePermission('m09:edit')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateServiceRequestDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.create(actor, dto);
  }

  /** 推进（PATCH /aftercare/service-requests/:id）——领单/解决单向迁移，终态防重 409 */
  @Patch(':id')
  @RequirePermission('m09:edit')
  @HttpCode(HttpStatus.OK)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateServiceRequestDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.svc.update(actor, id, dto);
  }
}
