import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Appointment, ApprovalItem } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../auth/auth.types';
import { ApprovalService } from '../approval/approval.service';
import { normalizePhone } from '../lead/lead.normalize';
import { KNOWLEDGE_KIND } from '../knowledge/knowledge.constants';
import { NotificationService } from '../notification/notification.service';
import { APPROVAL_TYPE_SCHEDULE_CONFIRM } from './appointment.constants';
import { AppointmentRepository } from './appointment.repository';
import { APPOINTMENT_STATUS } from './appointment.states';
import { BUSINESS_TYPE_VALUES, type BusinessType } from './delivery.constants';
import { assertTechnicianSkill } from './technician-skill';
import type {
  ConflictCheckQueryDto,
  CreateAppointmentDto,
  ListAppointmentsQueryDto,
  TechnicianChangeConfirmDto,
  TechnicianChangeRequestDto,
} from './dto/appointment.dto';

/** 创建返回的确定性知识提示（非模型输出，S11） */
export interface AppointmentHints {
  estHours: Array<{ title: string; source: string | null; key: string }>;
  technician: Array<{ title: string; source: string | null; key: string }>;
}

/** 冲突提示项（对外可见的提醒口径） */
export interface ConflictInfo {
  id: string;
  workbench: string | null;
  technicianName: string | null;
  serviceItem: string | null;
  startAt: Date;
  endAt: Date | null;
  status: string;
}

function toConflictInfo(a: Appointment): ConflictInfo {
  return {
    id: a.id,
    workbench: a.workbench,
    technicianName: a.technicianName,
    serviceItem: a.serviceItem,
    startAt: a.startAt,
    endAt: a.endAt,
    status: a.status,
  };
}

/** 预约服务（P5-01/02/03，M07）：档期冲突检测 + 指定技师替换确认 + 排期店长审批。
 * 全部规则为确定性代码（S11）；排期生效仅经审批回调（A02）。
 * 通知接线（V2.2a，尽力而为）：排期审批通过回调确认成功后通知预约发起人（createdBy）。 */
@Injectable()
export class AppointmentService implements OnModuleInit {
  private readonly logger = new Logger(AppointmentService.name);

  constructor(
    private readonly repo: AppointmentRepository,
    private readonly audit: AuditService,
    private readonly approval: ApprovalService,
    private readonly notifications: NotificationService,
    private readonly prisma: PrismaService,
  ) {}

  /** 客户档案解析（2026-08-25）：优先显式 customerId；传 leadId 时按客资联系方式
   * 查找/创建客户档案并回写 lead.customerId（LeadRepository.findOrCreateCustomer 同口径）。 */
  private async resolveCustomerId(dto: { leadId?: string; customerId?: string }): Promise<string> {
    if (dto.customerId) return dto.customerId;
    const lead = await this.prisma.lead.findUniqueOrThrow({
      where: { id: dto.leadId! },
      select: { id: true, customerId: true, customerName: true, phone: true, wechat: true },
    });
    if (lead.customerId) return lead.customerId;

    // 精确等值查询代替全表载入（2026-08-26 审查 #8）：Customer.phone 落库即归一化值，
    // 电话可直接等值命中；wechat 库内为原文，等值 + 大小写不敏感兜底。
    // 空白差异未命中时建档——lead 级去重仍由 DedupService 兜底，不产生重复客资挂链。
    const phone = lead.phone ? normalizePhone(lead.phone) : null;
    const oldest = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
    let customer: { id: string } | null = null;
    if (phone) {
      customer = await this.prisma.customer.findFirst({
        where: { phone },
        orderBy: oldest,
        select: { id: true },
      });
    }
    if (!customer && lead.wechat) {
      customer = await this.prisma.customer.findFirst({
        where: { wechat: { equals: lead.wechat, mode: 'insensitive' } },
        orderBy: oldest,
        select: { id: true },
      });
    }
    if (!customer) {
      customer = await this.prisma.customer.create({
        data: {
          name: lead.customerName ?? '未命名客户',
          phone: phone ?? lead.phone ?? '',
          wechat: lead.wechat ?? null,
        },
        select: { id: true },
      });
    }
    await this.prisma.lead.update({
      where: { id: lead.id },
      data: { customerId: customer.id },
    });
    return customer.id;
  }

  /** 排期审批回调（P5-03）：approve → 置 managerConfirmed + 确认人/时间；
   * reject → 同步取消预约并释放档期（2026-08-28 UI 测试 #3：此前驳回后预约永久悬空 pending，
   * 审批中心不再显示、无人能批也无法取消）。 */
  onModuleInit(): void {
    this.approval.registerHandler(async (item) => {
      if (item.type !== APPROVAL_TYPE_SCHEDULE_CONFIRM) return;
      const payload = item.payload as { appointmentId?: string };
      if (!payload.appointmentId) {
        this.logger.warn(`排期审批载荷缺 appointmentId：${item.id}`);
        return;
      }
      if (item.status === 'rejected') {
        await this.onScheduleRejected(item, payload.appointmentId);
        return;
      }
      if (item.status !== 'approved') return;
      await this.repo.confirmByManager(payload.appointmentId, item.approverId ?? '');
      // 客资联动（2026-08-27 全流程测试 #8d）：排期确认=客户已约到店——阶段推进 visit_booked、
      // 落 visitApptAt、时间线留痕。条件更新防越级（won/lost 等终态客资不动），尽力而为不阻断回调。
      try {
        const appt = await this.repo.findById(payload.appointmentId);
        if (appt?.leadId && appt.startAt) {
          const moved = await this.prisma.lead.updateMany({
            where: {
              id: appt.leadId,
              stage: { in: ['new', 'contacted', 'communicating', 'quoted'] },
            },
            data: { stage: 'visit_booked', visitApptAt: appt.startAt },
          });
          if (moved.count > 0) {
            await this.prisma.leadEvent.create({
              data: {
                leadId: appt.leadId,
                kind: 'stage_changed',
                content: { from: '预约确认联动', to: 'visit_booked', appointmentId: appt.id },
                operatorId: item.approverId ?? null,
              },
            });
          }
        }
      } catch (err) {
        this.logger.warn(
          `排期确认联动客资阶段失败（不阻断）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await this.audit.record({
        actorId: item.approverId ?? undefined,
        action: 'appointment.confirmed',
        objectType: 'appointment',
        objectId: payload.appointmentId,
        after: { via: APPROVAL_TYPE_SCHEDULE_CONFIRM, approvalId: item.id },
      });
      // 排期确认成功 → 通知发起人（V2.2a 尽力而为，不阻塞回调）；
      // createdBy 可空（历史数据无发起人）：无人可通知则跳过
      const appointment = await this.repo.findById(payload.appointmentId);
      const createdBy = appointment?.createdBy;
      if (appointment && createdBy) {
        void this.safeNotify(
          () =>
            this.notifications.notify({
              userIds: [createdBy],
              kind: 'appointment_confirmed',
              title: `排期已确认：${appointment.serviceItem}`,
              body: `${appointment.startAt.toISOString()} 起，工位 ${appointment.workbench ?? '未定'}`,
              link: '/appointments',
              sourceType: 'appointment',
              sourceId: appointment.id,
            }),
          `appointment_confirmed(${appointment.id})`,
        );
      }
    });
  }

  /** 驳回排期审批联动（2026-08-28 UI 测试 #3）：取消预约释放档期＋审计＋通知发起人重提。
   * cancel 条件更新只影响 pending/confirmed 存量；已取消/不存在时静默（幂等）。 */
  private async onScheduleRejected(item: ApprovalItem, appointmentId: string): Promise<void> {
    const appointment = await this.repo.findById(appointmentId);
    if (!appointment || appointment.status === APPOINTMENT_STATUS.CANCELLED) return;
    const count = await this.repo.cancel(appointmentId);
    if (count === 0) return;
    await this.audit.record({
      actorId: item.approverId ?? undefined,
      action: 'appointment.cancelled',
      objectType: 'appointment',
      objectId: appointmentId,
      before: { status: appointment.status },
      after: { status: APPOINTMENT_STATUS.CANCELLED, via: '排期审批驳回', approvalId: item.id },
    });
    if (appointment.createdBy) {
      void this.safeNotify(
        () =>
          this.notifications.notify({
            userIds: [appointment.createdBy!],
            kind: 'appointment_cancelled',
            title: `排期被驳回，预约已取消：${appointment.serviceItem ?? ''}`,
            body: item.opinion
              ? `驳回理由：${item.opinion}。请调整后重新发起预约。`
              : '请调整后重新发起预约。',
            link: '/appointments',
            sourceType: 'appointment',
            sourceId: appointmentId,
          }),
        `appointment_rejected(${appointmentId})`,
      );
    }
  }

  /** 创建预约：技能池校验（v1.5 §5.4）→ 冲突检测 → 拦截；通过则落 pending 并发起排期审批（P5-03）。
   * 2026-08-25：customerId 可缺省——传 leadId 时按客资联系方式查找/创建客户档案并回写
   * lead.customerId（dedup findOrCreateCustomer 同口径），打通「客资→预约」链路。 */
  async create(
    actor: JwtPayload,
    dto: CreateAppointmentDto,
  ): Promise<{
    appointment: Appointment;
    hints: AppointmentHints;
  }> {
    if (dto.leadId && !(await this.repo.leadExists(dto.leadId))) {
      throw new AppException(ErrorCode.NOT_FOUND, '关联客资不存在');
    }
    const customerId = await this.resolveCustomerId(dto);
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    await assertTechnicianSkill(dto.technicianName, dto.businessType, (n) =>
      this.repo.findTechnicianByName(n),
    );
    const conflicts = await this.repo.findConflicts({
      workbench: dto.workbench,
      technicianName: dto.technicianName,
      startAt,
      endAt,
    });
    if (conflicts.length > 0) {
      throw new AppException(
        ErrorCode.APPOINTMENT_CONFLICT,
        '档期冲突：同一工位/技师同时段已有预约',
        {
          conflicts: conflicts.map(toConflictInfo),
        },
      );
    }

    const appointment = await this.repo.create({
      leadId: dto.leadId,
      customerId,
      opportunityId: dto.opportunityId,
      serviceItem: dto.serviceItem,
      businessType: dto.businessType,
      workbench: dto.workbench,
      technicianName: dto.technicianName,
      technicianDesignated: dto.technicianDesignated,
      estHours: dto.estHours,
      startAt,
      endAt,
      promise: dto.promise,
      status: APPOINTMENT_STATUS.PENDING,
      createdBy: actor.sub,
    });

    // 排期确认走审批流（P1-05 框架）：未确认不生效（施工单创建被拦截，见 work-order 服务）
    await this.approval.create(actor, {
      type: APPROVAL_TYPE_SCHEDULE_CONFIRM,
      payload: {
        appointmentId: appointment.id,
        summary: `${dto.serviceItem}｜${fmtCST(startAt)} ~ ${fmtCST(endAt)}｜工位 ${dto.workbench ?? '未定'}｜技师 ${dto.technicianName ?? '未定'}`,
      },
      basis: 'P5-03 排期须店长确认（任务卡/PERMISSION_MATRIX M07）',
    });

    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'appointment.created',
      objectType: 'appointment',
      objectId: appointment.id,
      after: {
        serviceItem: dto.serviceItem,
        startAt: startAt.toISOString(),
        status: APPOINTMENT_STATUS.PENDING,
      },
    });

    // 确定性知识提示（S11）：工时参考（产品类）+ 技师专长（技师类）
    const [estHours, technician] = await Promise.all([
      this.repo.findActiveKnowledgeByKeyword(KNOWLEDGE_KIND.PRODUCT, dto.serviceItem),
      dto.technicianName
        ? this.repo.findActiveKnowledgeByKeyword(KNOWLEDGE_KIND.TECHNICIAN, dto.technicianName)
        : Promise.resolve([]),
    ]);
    return { appointment, hints: { estHours, technician } };
  }

  list(query: ListAppointmentsQueryDto): Promise<Appointment[]> {
    return this.repo.findMany({
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      status: query.status,
    });
  }

  async get(id: string): Promise<Appointment> {
    const appointment = await this.repo.findById(id);
    if (!appointment) throw new AppException(ErrorCode.NOT_FOUND, '预约不存在');
    return appointment;
  }

  /** 冲突预检：不创建，仅返回占用提醒（P5-01「冲突提醒可见」） */
  async checkConflicts(query: ConflictCheckQueryDto): Promise<{ conflicts: ConflictInfo[] }> {
    const conflicts = await this.repo.findConflicts({
      workbench: query.workbench,
      technicianName: query.technicianName,
      startAt: new Date(query.startAt),
      endAt: new Date(query.endAt),
    });
    return { conflicts: conflicts.map(toConflictInfo) };
  }

  /** 取消预约（发起方）：释放档期 */
  async cancel(actor: JwtPayload, id: string): Promise<{ id: string; status: string }> {
    const appointment = await this.get(id);
    // 2026-08-28 bug1：已确认排期直接取消会绕过审批确认的效力——确认后取消属管理动作，
    // 仅老板/店长可操作；销售只能取消待确认的预约（走改期/联系店长）
    if (appointment.status === APPOINTMENT_STATUS.CONFIRMED) {
      const user = await this.prisma.user.findUnique({
        where: { id: actor.sub },
        select: { userRoles: { select: { role: { select: { code: true } } } } },
      });
      const roles = user?.userRoles.map((ur) => ur.role.code) ?? [];
      if (!roles.includes('boss') && !roles.includes('store_manager')) {
        throw new AppException(
          ErrorCode.PERM_DENIED,
          '排期已确认，取消需店长或老板操作（销售请走改期或联系店长）',
        );
      }
    }
    const count = await this.repo.cancel(id);
    if (count === 0) {
      throw new AppException(ErrorCode.APPOINTMENT_INVALID_STATE, '预约已取消，无需重复操作');
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'appointment.cancelled',
      objectType: 'appointment',
      objectId: id,
      before: { status: APPOINTMENT_STATUS.PENDING },
      after: { status: APPOINTMENT_STATUS.CANCELLED },
    });
    return { id, status: APPOINTMENT_STATUS.CANCELLED };
  }

  /** 发起技师替换（P5-02）：落 pending 记录，不影响当前排期。
   * 2026-08-28 UI 测试 #2：预约未指定技师时原口径直接拒绝——替换流程只覆盖已有技师，
   * 而「无技师预约」除建单时现场指定外无处可补。放开为「初次指定」：同走客户确认后生效，
   * fromName 记「（初次指定）」留痕，确认路径复用（confirmTechnicianChange → setTechnician）。 */
  async requestTechnicianChange(
    actor: JwtPayload,
    appointmentId: string,
    dto: TechnicianChangeRequestDto,
  ) {
    const appointment = await this.get(appointmentId);
    if (appointment.status === APPOINTMENT_STATUS.CANCELLED) {
      throw new AppException(ErrorCode.APPOINTMENT_INVALID_STATE, '已取消预约不能指定技师');
    }
    if (!appointment.technicianName) {
      const change = await this.repo.createTechnicianChange({
        appointmentId,
        fromName: '（初次指定）',
        toName: dto.toName,
        reason: dto.reason,
        requestedBy: actor.sub,
      });
      await this.audit.record({
        actorId: actor.sub,
        actorName: actor.username,
        action: 'appointment.tech_change_requested',
        objectType: 'appointment',
        objectId: appointmentId,
        after: { changeId: change.id, fromName: change.fromName, toName: change.toName },
      });
      return change;
    }
    if (dto.toName === appointment.technicianName) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, '新技师与当前技师相同');
    }
    const change = await this.repo.createTechnicianChange({
      appointmentId,
      fromName: appointment.technicianName,
      toName: dto.toName,
      reason: dto.reason,
      requestedBy: actor.sub,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'appointment.tech_change_requested',
      objectType: 'appointment',
      objectId: appointmentId,
      after: { changeId: change.id, fromName: change.fromName, toName: change.toName },
    });
    return change;
  }

  /** 客户确认替换（P5-02）：确认后技师变更才生效；未确认前预约技师不变 */
  async confirmTechnicianChange(
    actor: JwtPayload,
    appointmentId: string,
    changeId: string,
    dto: TechnicianChangeConfirmDto,
  ) {
    const appointment = await this.get(appointmentId);
    const change = await this.repo.findTechnicianChange(changeId);
    if (!change || change.appointmentId !== appointmentId) {
      throw new AppException(ErrorCode.NOT_FOUND, '替换记录不存在');
    }
    // 落库前技能池校验（v1.5 §5.4）：businessType 为空的历史单跳过
    const bt = appointment.businessType;
    if (bt && (BUSINESS_TYPE_VALUES as readonly string[]).includes(bt)) {
      await assertTechnicianSkill(change.toName, bt as BusinessType, (n) =>
        this.repo.findTechnicianByName(n),
      );
    }
    const count = await this.repo.confirmTechnicianChange(changeId, dto.confirmMethod);
    if (count === 0) {
      throw new AppException(ErrorCode.APPOINTMENT_INVALID_STATE, '替换记录已确认或已关闭');
    }
    // 生效：技师变更（仅此路径可改 technicianName）
    const updated = await this.repo.setTechnician(appointmentId, change.toName);
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'appointment.tech_change_confirmed',
      objectType: 'appointment',
      objectId: appointmentId,
      after: { changeId, confirmMethod: dto.confirmMethod, technicianName: change.toName },
    });
    return updated;
  }

  listTechnicianChanges(appointmentId: string) {
    return this.repo.listTechnicianChanges(appointmentId);
  }

  /** 尽力而为发通知（S09）：内部兜底捕获，任何失败仅记日志不外抛；调用处一律 void 不 await */
  private async safeNotify(action: () => Promise<unknown>, context: string): Promise<void> {
    try {
      await action();
    } catch (err) {
      this.logger.warn(
        `通知发送失败（${context}）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** 东八区可读时间（2026-08-27 #7）：MM-DD HH:mm，审批 summary 用——部署机时区不可依赖 */
function fmtCST(d: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  })
    .format(d)
    .replace(/\//g, '-');
}
