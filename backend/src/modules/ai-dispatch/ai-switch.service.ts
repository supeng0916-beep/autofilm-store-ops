import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../auth/auth.types';
import { AiTaskRegistry } from './ai-dispatch.registry';

const GLOBAL_KEY = 'ai.global.enabled';
const skillKey = (taskType: string) => `ai.skill.${taskType}.enabled`;

/** AI 停止开关（规格 §8：全局 + 每 skill 独立，管理员一键关闭，即时生效）。
 * 落 SystemMeta（D-P2-3），缺省视为开启；变更必审计。 */
@Injectable()
export class AiSwitchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AiTaskRegistry,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  private async read(key: string): Promise<boolean> {
    const meta = await this.prisma.systemMeta.findUnique({ where: { key } });
    return meta ? meta.value === 'true' : true; // 缺省开启
  }

  async globalEnabled(): Promise<boolean> {
    return this.read(GLOBAL_KEY);
  }

  async skillEnabled(taskType: string): Promise<boolean> {
    return this.read(skillKey(taskType));
  }

  /** 通道可用性 = 配置齐全 && 全局开关 && skill 开关（门禁判定，Task 7 设计决策 2/3）。
   * 主动抛错（区别于提交失败的静默降级）：开关是管理员明示状态，调用方需要明确信号。 */
  async assertEnabled(taskType: string): Promise<void> {
    // P3 遗留回收：WS URL 与 token 任一缺失都算通道未配置（网关鉴权必需，只查 URL 会漏报）
    if (
      !this.config.get<string>('WG_OPENCLAW_GATEWAY_WS_URL') ||
      !this.config.get<string>('WG_OPENCLAW_GATEWAY_TOKEN')
    ) {
      throw new AppException(ErrorCode.AI_DISABLED, 'AI 通道未配置', {
        reason: 'not_configured',
      });
    }
    if (!(await this.globalEnabled())) {
      throw new AppException(ErrorCode.AI_DISABLED, 'AI 全局开关已关闭，请人工处理', {
        reason: 'switch',
      });
    }
    if (!(await this.skillEnabled(taskType))) {
      throw new AppException(ErrorCode.AI_DISABLED, `AI 技能 ${taskType} 已关闭，请人工处理`, {
        reason: 'switch',
      });
    }
  }

  /** 开关状态全景（ai/status 与 ai/switches 共用） */
  async snapshot(): Promise<{ global: boolean; skills: { taskType: string; enabled: boolean }[] }> {
    const skills = await Promise.all(
      this.registry.list().map(async (def) => ({
        taskType: def.taskType,
        enabled: await this.skillEnabled(def.taskType),
      })),
    );
    return { global: await this.globalEnabled(), skills };
  }

  /** 切换开关：upsert + 审计（actor 必填——仅 system:manage 可调用） */
  async setSwitch(
    actor: JwtPayload,
    target: { scope: 'global' } | { scope: 'skill'; taskType: string },
    enabled: boolean,
  ): Promise<void> {
    const key = target.scope === 'global' ? GLOBAL_KEY : skillKey(target.taskType);
    if (target.scope === 'skill') this.registry.get(target.taskType); // 未注册类型拒收
    const before = await this.read(key);
    await this.prisma.systemMeta.upsert({
      where: { key },
      create: { key, value: String(enabled) },
      update: { value: String(enabled) },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'ai.switch.changed',
      objectType: 'ai_switch',
      objectId: key,
      before: { enabled: before },
      after: { enabled },
    });
  }
}
