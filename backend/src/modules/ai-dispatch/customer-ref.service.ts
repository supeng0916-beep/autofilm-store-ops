import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

/** 假名 ID 映射管理（A04 / 规格 §5.4）：客户以 ref_id 参与 AI 任务；
 * 映射只存本地库，不进模型上下文、不落日志。 */
@Injectable()
export class CustomerRefService {
  constructor(private readonly prisma: PrismaService) {}

  /** 幂等取得客户假名 ID（无则创建）。
   * upsert 取代「先查后建」的 TOCTOU 竞态（P2 终审 triage）；并发下撞唯一键则重查已落库映射。 */
  async getOrCreate(customerId: string): Promise<string> {
    const refId = `ref_${customerId.slice(-8)}_${Date.now().toString(36)}`;
    try {
      const row = await this.prisma.customerRefId.upsert({
        where: { customerId },
        create: { customerId, refId },
        update: {}, // 已存在则保持原 refId（幂等）
      });
      return row.refId;
    } catch (err) {
      // 并发下多请求同时 upsert 同一 customerId 可能撞唯一键（P2002）：捕获后重查取已落库映射
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.customerRefId.findUniqueOrThrow({
          where: { customerId },
        });
        return existing.refId;
      }
      throw err;
    }
  }
}
