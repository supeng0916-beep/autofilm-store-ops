import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { AiDispatchService } from './ai-dispatch.service';
import { AI_TASK_STATUS, type AiTaskStatus } from './ai-dispatch.states';
import { AiTaskRepository } from './ai-task.repository';

/** 状态枚举数组化供 z.enum 复用（states 常量为唯一事实源，避免双写漂移） */
const AI_TASK_STATUS_VALUES = Object.values(AI_TASK_STATUS) as [AiTaskStatus, ...AiTaskStatus[]];

class ConsoleListQueryDto extends createZodDto(
  z.object({
    status: z.enum(AI_TASK_STATUS_VALUES).optional(),
    taskType: z.string().min(1).optional(),
  }),
) {}

/** Agent 任务控制台（V2.2b Task1）：boss/sys_admin 全局视角的只读端点。
 * 与 AiController（@Controller('ai')）路由不冲突：本控制器只新增 GET /ai/tasks*，
 * 既有 POST /ai/tasks/hello 归属 AiController。
 * 权限沿用 AI 通道成本行口径：ai:cost:view ∪ system:manage（PERMISSION_MATRIX，任一满足）。 */
@Controller('ai/tasks')
export class AiTasksController {
  constructor(
    private readonly repo: AiTaskRepository,
    private readonly dispatch: AiDispatchService,
  ) {}

  /** 任务列表：可选筛选，最近 50 条（AiTask 全字段直出，含输入摘要/输出/成本/耗时时间戳） */
  @Get()
  @RequirePermission('ai:cost:view', 'system:manage')
  list(@Query() query: ConsoleListQueryDto) {
    return this.repo.findConsoleTasks({ status: query.status, taskType: query.taskType });
  }

  /** 任务详情：任务 + 事件时间线（createdAt asc） */
  @Get(':id')
  @RequirePermission('ai:cost:view', 'system:manage')
  async detail(@Param('id') id: string) {
    const task = await this.repo.findById(id);
    if (!task) {
      throw new AppException(ErrorCode.NOT_FOUND, 'AI 任务不存在');
    }
    return { task, events: await this.repo.findEvents(id) };
  }

  /** 重试（V2.2b Task2）：以新任务重放，返回新 AiTask（201） */
  @Post(':id/retry')
  @RequirePermission('ai:cost:view', 'system:manage')
  retry(@Param('id') id: string) {
    return this.dispatch.retry(id);
  }

  /** 人工接管（V2.2b Task2）：写 manual_takeover 事件 + 审计，幂等；首答与幂等重复均 200 */
  @Post(':id/takeover')
  @HttpCode(200)
  @RequirePermission('ai:cost:view', 'system:manage')
  takeover(@CurrentUser() actor: JwtPayload, @Param('id') id: string) {
    return this.dispatch.takeover(actor, id);
  }
}
