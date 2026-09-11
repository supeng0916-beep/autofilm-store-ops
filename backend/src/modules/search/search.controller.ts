import { Controller, Get, Query } from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { SearchQueryDto, SearchQueryPipe } from './dto/search.dto';
import { SearchService } from './search.service';

/** 全局搜索统一端点（V2.3a）：仅需认证，不设权限点——
 * 分节可见与数据范围由服务端按角色裁剪（sys_admin 返回空节而非 403）。 */
@Controller('search')
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  @Get()
  search(@Query(new SearchQueryPipe()) query: SearchQueryDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.search(actor, query.q);
  }
}
