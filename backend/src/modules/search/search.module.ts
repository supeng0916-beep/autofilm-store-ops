import { Module } from '@nestjs/common';

import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/** 全局搜索模块（V2.3a）：一处搜索全店信息——客资/知识/预约/施工单只读聚合 */
@Module({
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
