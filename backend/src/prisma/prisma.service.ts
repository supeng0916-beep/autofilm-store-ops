import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/** 全局 Prisma 客户端。惰性连接：不在启动时 $connect，
 * 避免 P0 阶段无数据库时应用无法启动；查询时自动建连。
 * Prisma 7 适配：不再支持裸 new PrismaClient()，构造时必须传驱动适配器（PrismaPg）；
 * 适配器基于 pg 连接池，同样按需建连，不破坏惰性语义。 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService) {
    // WG_DATABASE_URL 已由 env.schema.ts 的 validateEnv 保证非空
    super({ adapter: new PrismaPg({ connectionString: config.get<string>('WG_DATABASE_URL')! }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
