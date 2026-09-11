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
import { ConfirmRewardsDto, CreateRewardRuleDto, UpdateRewardRuleDto } from './dto/reward-rule.dto';
import { RewardRuleService } from './reward-rule.service';

/** 奖惩规则端点（批次3）：boss∪sys_admin（服务层硬校验）；preview 出草案、confirm 人拍板落档 */
@Controller('team/reward-rules')
export class RewardRuleController {
  constructor(private readonly rewards: RewardRuleService) {}

  @Get()
  list(@CurrentUser() actor: JwtPayload) {
    return this.rewards.list(actor);
  }

  @Post()
  create(@Body() dto: CreateRewardRuleDto, @CurrentUser() actor: JwtPayload) {
    return this.rewards.create(actor, dto);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRewardRuleDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.rewards.update(actor, id, dto);
  }

  /** 月度草案（?month=YYYY-MM，缺省当月）：按启用规则×技师事实现算，不落库 */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(@Query('month') month: string, @CurrentUser() actor: JwtPayload) {
    const m = month?.trim() || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) {
      throw new Error('月份格式 YYYY-MM');
    }
    return this.rewards.preview(actor, m);
  }

  /** 确认草案（人拍板）：写技师档案奖惩记录 + 幂等（同月同人同规则不重复） */
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  confirm(@Body() dto: ConfirmRewardsDto, @CurrentUser() actor: JwtPayload) {
    return this.rewards.confirm(actor, dto);
  }
}
