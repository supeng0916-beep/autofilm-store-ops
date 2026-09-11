import { Injectable, OnModuleInit } from '@nestjs/common';
import type { StaffRecord, Technician } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../prisma/prisma.service';
import { AiTaskRegistry } from '../ai-dispatch/ai-dispatch.registry';
import type { JwtPayload } from '../auth/auth.types';
import { PLACEHOLDER_TECHNICIAN_NAMES, SEED_TECHNICIANS } from './team.constants';
import type {
  CreateStaffRecordDto,
  CreateTechnicianDto,
  UpdateTechnicianBody,
} from './dto/team.dto';

/** 技师卡（overview 上区）：kind 供前端 AI 徽标区分人机身份（技师 kind:'technician'） */
export interface TechnicianCard {
  id: string;
  kind: 'technician';
  name: string;
  /** 工种数组（v1.5 String[]）：window_film/car_cover/color_change，空数组=占位未填 */
  skills: string[];
  active: boolean;
  /** 有活=最新一张非终态施工单（待入场/施工中/自检/复检，technicianName 姓名匹配，V1 口径），空闲为 null */
  currentWorkOrder: { orderNo: string; stage: string } | null;
  stats: { total: number; delivered: number; rework: number; revenueFen: number };
}

/** Agent 花名册行（overview 中区）：registry 代码事实 + ai_tasks 近 30 天聚合 */
export interface AgentRow {
  taskType: string;
  skillName: string;
  kind: 'agent';
  recent30d: {
    total: number;
    /** 完成率 0-1（status=done 占比，分母 0 时置 0，口径同 analytics 比率取整） */
    doneRate: number;
    /** 平均耗时秒（仅有 finishedAt 的任务按 finishedAt-createdAt 计入；无样本为 null） */
    avgSeconds: number | null;
    /** 最近一次运行（窗口内最大 createdAt，无运行为 null） */
    lastRunAt: string | null;
  };
}

/** 人员记录行（overview 下区）：展示名（技师名/录入人显示名）由服务层拼装 */
export interface StaffRecordRow {
  id: string;
  subjectType: string;
  subjectId: string;
  subjectName: string | null;
  kind: string;
  content: string;
  occurredAt: string;
  recordedBy: string;
  recorderName: string | null;
  createdAt: string;
}

export interface TeamOverview {
  technicians: TechnicianCard[];
  agents: AgentRow[];
  records: StaffRecordRow[];
}

/** 人机团队聚合服务（M08，V2.4）：三源拼装——技师档案（technicians 表）+
 * 施工指标（work_orders 按 technicianName 聚合，口径同 analytics.byTechnician）+
 * Agent 花名册（AiTaskRegistry.list() 代码事实 + ai_tasks 近 30 天 groupBy）。
 * 写操作服务层角色硬校验 boss|store_manager（PERM_DENIED 403）。 */
@Injectable()
export class TeamService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AiTaskRegistry,
  ) {}

  /** 启动时同步合成演示技师（幂等，见 syncTechnicianSeed）。 */
  async onModuleInit(): Promise<void> {
    await this.syncTechnicianSeed();
  }

  /** 演示种子同步（幂等）：空表创建演示配置；非空清理历史占位名称、按名补缺，
   * 并为 skills 为空的种子技师回填演示技能。
   * 本作品集仅面向独立演示库；改名走 PATCH 不走此处；
   * 非空 skills 视为人工维护（PATCH 所改），同步不覆盖。 */
  async syncTechnicianSeed(): Promise<void> {
    const count = await this.prisma.technician.count();
    if (count === 0) {
      await this.prisma.technician.createMany({
        data: SEED_TECHNICIANS.map((t) => ({ name: t.name, skills: [...t.skills] })),
      });
      return;
    }
    await this.prisma.technician.deleteMany({
      where: { name: { in: [...PLACEHOLDER_TECHNICIAN_NAMES] } },
    });
    const existing = await this.prisma.technician.findMany({
      where: { name: { in: SEED_TECHNICIANS.map((t) => t.name) } },
      select: { id: true, name: true, skills: true },
    });
    const byName = new Map(existing.map((t) => [t.name, t]));
    const missing = SEED_TECHNICIANS.filter((t) => !byName.has(t.name));
    if (missing.length > 0) {
      await this.prisma.technician.createMany({
        data: missing.map((t) => ({ name: t.name, skills: [...t.skills] })),
      });
    }
    for (const seed of SEED_TECHNICIANS) {
      const row = byName.get(seed.name);
      if (row && row.skills.length === 0) {
        await this.prisma.technician.update({
          where: { id: row.id },
          data: { skills: [...seed.skills] },
        });
      }
    }
  }

  /** 人机团队总览（GET /team/overview） */
  async overview(): Promise<TeamOverview> {
    const technicians = await this.prisma.technician.findMany({
      orderBy: { createdAt: 'asc' },
    });

    const [cards, agents, records] = await Promise.all([
      this.technicianCards(technicians),
      this.agentRows(),
      this.recentRecords(technicians),
    ]);

    return { technicians: cards, agents, records };
  }

  /** 新建技师（资源实体，非登录账号——决策 C）：skills 缺省落空数组（占位未填） */
  async createTechnician(actor: JwtPayload, dto: CreateTechnicianDto): Promise<Technician> {
    await this.assertManager(actor.sub);
    return this.prisma.technician.create({
      data: { name: dto.name, skills: dto.skills ?? [] },
    });
  }

  /** 更新技师：改名/专长/停用（active=false 留痕不删；改名即迁移忙闲与指标姓名匹配口径） */
  async updateTechnician(
    actor: JwtPayload,
    id: string,
    dto: UpdateTechnicianBody,
  ): Promise<Technician> {
    await this.assertManager(actor.sub);
    const existing = await this.prisma.technician.findUnique({ where: { id } });
    if (!existing) throw new AppException(ErrorCode.NOT_FOUND, '技师不存在');
    return this.prisma.technician.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        // skills 列 NOT NULL（v1.5 数组合并迁移）：DTO 传 null 显式清空时落空数组
        ...(dto.skills !== undefined ? { skills: dto.skills ?? [] } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
    });
  }

  /** 录入人员记录：subjectType 固定 technician（V1 对象限技师）；只增不改（留痕，无更新/删除端点） */
  async createRecord(actor: JwtPayload, dto: CreateStaffRecordDto): Promise<StaffRecordRow> {
    await this.assertManager(actor.sub);
    const subject = await this.prisma.technician.findUnique({ where: { id: dto.subjectId } });
    if (!subject) throw new AppException(ErrorCode.NOT_FOUND, '记录对象技师不存在');
    const record: StaffRecord = await this.prisma.staffRecord.create({
      data: {
        subjectType: 'technician',
        subjectId: dto.subjectId,
        kind: dto.kind,
        content: dto.content,
        occurredAt: new Date(dto.occurredAt),
        recordedBy: actor.sub,
      },
    });
    const recorder = await this.prisma.user.findUnique({
      where: { id: actor.sub },
      select: { displayName: true },
    });
    return {
      id: record.id,
      subjectType: record.subjectType,
      subjectId: record.subjectId,
      subjectName: subject.name,
      kind: record.kind,
      content: record.content,
      occurredAt: record.occurredAt.toISOString(),
      recordedBy: record.recordedBy,
      recorderName: recorder?.displayName ?? null,
      createdAt: record.createdAt.toISOString(),
    };
  }

  /** 技师卡：档案 + 忙闲 + 指标（口径同 analytics.service byTechnician：
   * 产值按技师×客资去重，leadId → won lead closedAmountFen，未关联/未成交不计） */
  private async technicianCards(technicians: Technician[]): Promise<TechnicianCard[]> {
    const names = technicians.map((t) => t.name);
    const workOrders = names.length
      ? await this.prisma.workOrder.findMany({
          where: { technicianName: { in: names } },
          select: {
            orderNo: true,
            technicianName: true,
            leadId: true,
            stage: true,
            rework: true,
            createdAt: true,
          },
        })
      : [];

    const leadIds = [
      ...new Set(workOrders.map((w) => w.leadId).filter((v): v is string => v !== null)),
    ];
    const wonLeads = leadIds.length
      ? await this.prisma.lead.findMany({
          where: { id: { in: leadIds }, finalStatus: 'won' },
          select: { id: true, closedAmountFen: true },
        })
      : [];
    const leadRevenue = new Map(wonLeads.map((l) => [l.id, l.closedAmountFen ?? 0]));

    interface Stat {
      total: number;
      delivered: number;
      rework: number;
      revenueFen: number;
      countedLeads: Set<string>;
    }
    const statMap = new Map<string, Stat>();
    const busyMap = new Map<string, { orderNo: string; stage: string; createdAt: Date }>();
    for (const w of workOrders) {
      const name = w.technicianName ?? '';
      const stat = statMap.get(name) ?? {
        total: 0,
        delivered: 0,
        rework: 0,
        revenueFen: 0,
        countedLeads: new Set<string>(),
      };
      stat.total++;
      if (w.stage === 'delivered') stat.delivered++;
      if (w.rework) stat.rework++;
      if (w.leadId && !stat.countedLeads.has(w.leadId)) {
        stat.revenueFen += leadRevenue.get(w.leadId) ?? 0;
        stat.countedLeads.add(w.leadId);
      }
      statMap.set(name, stat);
      // 忙闲（2026-08-28 修复）：非终态施工单（待入场/施工中/自检/复检）都算有活，
      // 取最新一张；原先只看 in_progress，待入场等阶段的师傅被误显空闲
      if (w.stage !== 'delivered') {
        const cur = busyMap.get(name);
        if (!cur || w.createdAt > cur.createdAt) {
          busyMap.set(name, { orderNo: w.orderNo, stage: w.stage, createdAt: w.createdAt });
        }
      }
    }

    return technicians.map((t) => {
      const stat = statMap.get(t.name);
      const busy = busyMap.get(t.name);
      return {
        id: t.id,
        kind: 'technician' as const,
        name: t.name,
        skills: t.skills,
        active: t.active,
        currentWorkOrder: busy ? { orderNo: busy.orderNo, stage: busy.stage } : null,
        stats: stat
          ? {
              total: stat.total,
              delivered: stat.delivered,
              rework: stat.rework,
              revenueFen: stat.revenueFen,
            }
          : { total: 0, delivered: 0, rework: 0, revenueFen: 0 },
      };
    });
  }

  /** Agent 花名册：registry 全量登记项 × ai_tasks 近 30 天聚合（done 率=status done；
   * avgSeconds=有 finishedAt 的 finishedAt-createdAt 均值；lastRunAt=max createdAt） */
  private async agentRows(): Promise<AgentRow[]> {
    const since = new Date(Date.now() - 30 * 86_400_000);
    // groupBy 无法对过滤子集聚合（done 数）与时间差（均耗时），故三路取数后内存拼装
    const [runGroups, doneGroups, finished] = await Promise.all([
      this.prisma.aiTask.groupBy({
        by: ['taskType'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      this.prisma.aiTask.groupBy({
        by: ['taskType'],
        where: { createdAt: { gte: since }, status: 'done' },
        _count: { _all: true },
      }),
      this.prisma.aiTask.findMany({
        where: { createdAt: { gte: since }, finishedAt: { not: null } },
        select: { taskType: true, createdAt: true, finishedAt: true },
      }),
    ]);
    const totalOf = new Map(runGroups.map((g) => [g.taskType, g._count._all]));
    const doneOf = new Map(doneGroups.map((g) => [g.taskType, g._count._all]));
    const lastOf = new Map(runGroups.map((g) => [g.taskType, g._max.createdAt]));
    const durations = new Map<string, number[]>();
    for (const t of finished) {
      const seconds = ((t.finishedAt?.getTime() ?? 0) - t.createdAt.getTime()) / 1000;
      const arr = durations.get(t.taskType) ?? [];
      arr.push(seconds);
      durations.set(t.taskType, arr);
    }
    const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : 0);

    return this.registry.list().map((def) => {
      const total = totalOf.get(def.taskType) ?? 0;
      const done = doneOf.get(def.taskType) ?? 0;
      const ds = durations.get(def.taskType) ?? [];
      const lastRunAt = lastOf.get(def.taskType);
      return {
        taskType: def.taskType,
        skillName: def.skillName,
        kind: 'agent' as const,
        recent30d: {
          total,
          doneRate: rate(done, total),
          avgSeconds:
            ds.length > 0
              ? Math.round((ds.reduce((a, b) => a + b, 0) / ds.length) * 10) / 10
              : null,
          lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
        },
      };
    });
  }

  /** 近期记录（20 条，新的在前）：技师名/录入人显示名拼装供页面直渲染 */
  private async recentRecords(technicians: Technician[]): Promise<StaffRecordRow[]> {
    const records = await this.prisma.staffRecord.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const subjectNames = new Map(technicians.map((t) => [t.id, t.name]));
    const recorderIds = [...new Set(records.map((r) => r.recordedBy))];
    const recorders = recorderIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: recorderIds } },
          select: { id: true, displayName: true },
        })
      : [];
    const recorderNames = new Map(recorders.map((u) => [u.id, u.displayName]));
    return records.map((r) => ({
      id: r.id,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      subjectName: subjectNames.get(r.subjectId) ?? null,
      kind: r.kind,
      content: r.content,
      occurredAt: r.occurredAt.toISOString(),
      recordedBy: r.recordedBy,
      recorderName: recorderNames.get(r.recordedBy) ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** 写角色校验（PERMISSION_MATRIX 硬边界）：仅 boss|store_manager；
   * 前端按钮近似口径 approval:decide 仅体验层，不构成本层依据（userRoleCodes 先例 dashboard/analytics） */
  private async assertManager(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { userRoles: { select: { role: { select: { code: true } } } } },
    });
    const roles = user?.userRoles.map((ur) => ur.role.code) ?? [];
    if (!roles.includes('boss') && !roles.includes('store_manager')) {
      throw new AppException(ErrorCode.PERM_DENIED, '仅老板/店长可执行人机团队写操作');
    }
  }
}
