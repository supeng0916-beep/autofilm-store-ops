import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** 列表查询：unread=1 只取未读（缺省全量） */
export class ListNotificationsQueryDto extends createZodDto(
  z.object({ unread: z.enum(['0', '1']).optional() }),
) {}
