import type { PipeTransform } from '@nestjs/common';
import { z } from 'zod';

import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-code';

/** 搜索词规则（唯一来源）：必填 2-100 字符（V2.3a 统一端点） */
export const searchQuerySchema = z.object({
  q: z.string().min(2, '搜索词至少 2 个字符').max(100, '搜索词至多 100 个字符'),
});

/** 查询载体：普通类（非 createZodDto）——全局 Zod 管道不识别则原样放行，
 * 由下方本路由管道接管校验，使非法 q 走 VALIDATION_FAILED → 422（V2.3a 口径），
 * 而非全局管道统一的 400（marketing 等既有端点口径，互不影响）。 */
export class SearchQueryDto {
  q!: string;
}

/** 本路由校验管道：仍以 Zod schema 为准，仅把异常映射为 AppException(VALIDATION_FAILED)。 */
export class SearchQueryPipe implements PipeTransform<unknown, SearchQueryDto> {
  transform(value: unknown): SearchQueryDto {
    const parsed = searchQuerySchema.safeParse(value);
    if (!parsed.success) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        '搜索词须为 2-100 个字符',
        parsed.error.issues,
      );
    }
    return parsed.data;
  }
}
