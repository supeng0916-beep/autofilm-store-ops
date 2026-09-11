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

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import {
  CreateKnowledgeDto,
  ListKnowledgeQueryDto,
  SourceFileQueryDto,
  UpdateKnowledgeDto,
} from './dto/create-knowledge.dto';
import { KnowledgeService } from './knowledge.service';

/** 知识库管理端点（P4-01）：CRUD + 版本管理 + 生效/过期 + 价格审批。
 * 权限：view 全员（m06:view），edit 店长/老板（m06:edit），approve 老板（m06:approve）。
 * 生效操作统一走 POST /:id/activate；价格类自动创建审批项，其余直接生效。 */
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly svc: KnowledgeService) {}

  /** 列表查询（GET /knowledge?kind=&status=&keyword=） */
  @Get()
  @RequirePermission('m06:view')
  list(@Query() query: ListKnowledgeQueryDto) {
    return this.svc.list(query);
  }

  /** 知识源文件只读（GET /knowledge/source-file?path=门店知识源/xx.md，#14）：
   * 白名单=仓库 `门店知识源/` 内 .md（服务层校验前缀+后缀+resolve 防穿越），供助手/知识库跳转原文。
   * 注意：必须声明在 @Get(':id') 之前，否则该字面量路由会被参数路由吞掉 */
  @Get('source-file')
  @RequirePermission('m06:view')
  sourceFile(@Query() query: SourceFileQueryDto) {
    return this.svc.readSourceFile(query.path);
  }

  /** 详情（GET /knowledge/:id） */
  @Get(':id')
  @RequirePermission('m06:view')
  async get(@Param('id') id: string) {
    const item = await this.svc.getById(id);
    if (!item) throw new AppException(ErrorCode.NOT_FOUND, '知识条目不存在');
    return item;
  }

  /** 版本历史（GET /knowledge/:id/versions） */
  @Get(':id/versions')
  @RequirePermission('m06:view')
  async versions(@Param('id') id: string) {
    const item = await this.svc.getById(id);
    if (!item) throw new AppException(ErrorCode.NOT_FOUND, '知识条目不存在');
    return this.svc.getVersions(item.kind, item.key);
  }

  /** 创建（POST /knowledge） */
  @Post()
  @RequirePermission('m06:edit')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateKnowledgeDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.create(actor, dto);
  }

  /** 编辑（PATCH /knowledge/:id）——生成新版本 */
  @Patch(':id')
  @RequirePermission('m06:edit')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateKnowledgeDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.svc.update(actor, id, dto);
  }

  /** 生效（POST /knowledge/:id/activate） */
  @Post(':id/activate')
  @RequirePermission('m06:edit')
  @HttpCode(HttpStatus.OK)
  activate(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.svc.activate(actor, id);
  }

  /** 过期（POST /knowledge/:id/expire） */
  @Post(':id/expire')
  @RequirePermission('m06:edit')
  @HttpCode(HttpStatus.OK)
  expire(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.svc.expire(actor, id);
  }
}
