import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CompetitorDailyService } from './competitor-daily.service';
import { MarketingService } from './marketing.service';
import { CompetitorNotesDto, VideoCopyDto, VideoPositioningDto } from './dto/marketing.dto';
import { AiDispatchService } from '../ai-dispatch/ai-dispatch.service';

/** 经营任务中心端点（V2.1 首批，M02）：一键任务=参数确认→AI 草稿→人工采用/审核。
 * 权限：m02:edit（制作）或 m02:approve（审核发布）任一——生成草稿不等于对外发布，
 * 老板/店长可用（2026-08-19 项目方要求）；输出均为草稿态（A02/A10）。 */
@Controller('marketing')
export class MarketingController {
  constructor(
    private readonly svc: MarketingService,
    private readonly daily: CompetitorDailyService,
    private readonly dispatch: AiDispatchService,
  ) {}

  /** 短视频文案草稿（POST /marketing/video-copy） */
  @Post('video-copy')
  @RequirePermission('m02:edit', 'm02:approve')
  @HttpCode(HttpStatus.OK)
  videoCopy(@Body() dto: VideoCopyDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.videoCopy(actor, dto);
  }

  /** 账号定位读取（GET /marketing/video/positioning）：未保存过返回按门店情况拟的默认草稿。
   * 定位是账号的"身份证"，无操作权限要求（只读不落库），编辑需 m02:edit */
  @Get('video/positioning')
  getVideoPositioning() {
    return this.svc.getVideoPositioning();
  }

  /** 账号定位保存（PUT /marketing/video/positioning，2026-09-04 短视频运营升级）：
   * 选题筛选与脚本生成都会注入；改动落审计 */
  @Put('video/positioning')
  @RequirePermission('m02:edit', 'm02:approve')
  saveVideoPositioning(@Body() dto: VideoPositioningDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.saveVideoPositioning(actor, dto);
  }

  /** 选题包生成（POST /marketing/video/topics）：手动按钮触发（拍板 2026-09-04，
   * 不做每日自动）——联网扫热点→按定位筛选→3~5 个选题建议；重跑覆盖当日结果 */
  @Post('video/topics')
  @RequirePermission('m02:edit', 'm02:approve')
  @HttpCode(HttpStatus.OK)
  generateVideoTopics(@CurrentUser() actor: JwtPayload) {
    return this.svc.generateVideoTopics(actor);
  }

  /** 当日选题包复看（GET /marketing/video/topics）：未生成过返回 null */
  @Get('video/topics')
  getVideoTopics() {
    return this.svc.getVideoTopics();
  }

  /** 同行动态日报手动触发（POST /marketing/competitor-daily/run，2026-08-27）：boss 硬校验；
   * 与每小时巡检同幂等键——当天已生成直接返回内容，不重复发通知 */
  @Post('competitor-daily/run')
  @HttpCode(HttpStatus.OK)
  runCompetitorDaily(@CurrentUser() actor: JwtPayload) {
    return this.daily.runManual(actor);
  }

  /** GEO 优化助手（POST /marketing/geo-audit，V1.5 批次4）：一键诊断门店可被搜索到程度——
   * 经 web_search 搜公开网络（口径 A 合规），输出建议态诊断与内容草稿，不承诺排名 */
  @Post('geo-audit')
  geoAudit(@CurrentUser() actor: JwtPayload) {
    // RF-03 配套：接自动重试（R1 拦截后带 lintFeedback 重派，与五个营销生成路由同口径）
    return this.dispatch.submitTaskAutoRetry(
      'marketing.geo_audit',
      {
        storeName: process.env.WG_STORE_NAME?.trim() || 'AutoFilm Demo',
        city: process.env.WG_STORE_CITY?.trim() || '本地',
        brand: '演示品牌 DEMO BRAND',
        keywords: ['本地贴膜', '演示品牌贴膜', '本地汽车贴膜店', '本地车衣'],
        platforms: ['地图', '点评', '本地生活', '网页搜索'],
        requestedBy: actor.username,
      },
      { type: 'marketing', id: actor.sub },
    );
  }

  /** 同行信息整理（POST /marketing/competitor-notes）——结果进知识库草稿待审核 */
  @Post('competitor-notes')
  @RequirePermission('m02:edit', 'm02:approve')
  @HttpCode(HttpStatus.OK)
  competitorNotes(@Body() dto: CompetitorNotesDto, @CurrentUser() actor: JwtPayload) {
    return this.svc.competitorNotes(actor, dto);
  }
}
