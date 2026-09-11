import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { ApprovalItem } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { JwtPayload } from '../auth/auth.types';
import { permissionsOf } from '../auth/permissions';
import { NotificationService } from '../notification/notification.service';
import type { ApproveDto, CreateApprovalDto, RejectDto } from './approval.dto';
import { ApprovalRepository } from './approval.repository';
import { APPROVAL_STATUS, type ApprovalStatus } from './approval.states';

/** 审批决定回调钩子（可选注入，避免 approval↔lead 循环依赖）。
 * LeadModule 注册该 token，approval.service.decide 成功后在审批项已提交后调用；
 * 处理方按 item.type 分发（本任务仅 lead.churn）。 */
export const APPROVAL_DECISION_HANDLER = Symbol('APPROVAL_DECISION_HANDLER');
export type ApprovalDecisionHandler = (item: ApprovalItem) => Promise<void>;

/** 审批人角色（V2.2a）：新审批待办群发给全部在职 boss 与 store_manager */
const APPROVER_ROLES = ['boss', 'store_manager'];

/** 审批编排：状态迁移用条件更新防并发竞态；每动作留痕（P1-05）。
 *
 * 「未批准项不产生任何对外效果」由结构保证：本模块只存类型与载荷，P1 无任何消费方；
 * P2+ 对外执行器只读 approved 项。在此之前 approval_items 不产生任何业务副作用。
 *
 * V1 决策：允许同人发起并审批（门店人手少，矩阵未禁止）；P6 验收时复核。
 *
 * 多处理器：APPROVAL_DECISION_HANDLER 为单一回调（LeadModule 注册），
 * registerHandler 为额外处理器注册通道（P4 KnowledgeModule 用此方式）。
 *
 * 通知接线（V2.2a，尽力而为）：create 后群发 approval_pending 给审批人角色，
 * decide（approve/reject）后发 approval_decided 给发起人——全部 void 不 await、失败仅记日志。 */
@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);
  private readonly extraHandlers: ApprovalDecisionHandler[] = [];

  constructor(
    private readonly repo: ApprovalRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    @Optional()
    @Inject(APPROVAL_DECISION_HANDLER)
    private readonly decisionHandler?: ApprovalDecisionHandler,
  ) {}

  /** 注册额外审批决定处理器（用于多模块共享审批回调，避免单 token 冲突） */
  registerHandler(handler: ApprovalDecisionHandler): void {
    this.extraHandlers.push(handler);
  }

  /** 发起审批：落库 pending 并写审计 approval.created */
  async create(actor: JwtPayload, dto: CreateApprovalDto): Promise<ApprovalItem> {
    const item = await this.repo.create({
      type: dto.type,
      payload: dto.payload,
      requesterId: actor.sub,
      basis: dto.basis,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'approval.created',
      objectType: 'approval',
      objectId: item.id,
      after: { status: APPROVAL_STATUS.PENDING, type: item.type },
    });
    // 通知审批人（V2.2a 尽力而为）：payload.summary 存在时作为正文摘要（如排期审批的时段摘要）
    const rawSummary = (item.payload as { summary?: unknown } | null)?.summary;
    const summary = typeof rawSummary === 'string' ? rawSummary : undefined;
    void this.safeNotify(
      () =>
        this.notifications.notifyRoleHolders(APPROVER_ROLES, {
          kind: 'approval_pending',
          title: `新审批待办：${item.type}`,
          body: summary,
          link: '/approvals',
          sourceType: 'approval',
          sourceId: item.id,
        }),
      `approval_pending(${item.id})`,
    );
    return item;
  }

  /** 批准：pending → approved，opinion 记意见（可空） */
  approve(actor: JwtPayload, id: string, dto: ApproveDto): Promise<ApprovalItem> {
    return this.decide(actor, id, APPROVAL_STATUS.APPROVED, dto.opinion, 'approval.approved');
  }

  /** 驳回：pending → rejected，opinion 落驳回理由（矩阵「结论/意见/依据」对应） */
  reject(actor: JwtPayload, id: string, dto: RejectDto): Promise<ApprovalItem> {
    return this.decide(actor, id, APPROVAL_STATUS.REJECTED, dto.reason, 'approval.rejected');
  }

  /** 撤回：仅发起人本人（否则 PERM_DENIED）、仅 pending 态 */
  async withdraw(actor: JwtPayload, id: string): Promise<ApprovalItem> {
    const item = await this.repo.findById(id);
    if (!item) {
      throw new AppException(ErrorCode.NOT_FOUND, '审批项不存在');
    }
    if (item.requesterId !== actor.sub) {
      throw new AppException(ErrorCode.PERM_DENIED, '仅发起人本人可撤回审批');
    }
    // 撤回不设 approverId（无决定人），仅记录状态迁移
    return this.transit(actor, item.id, APPROVAL_STATUS.WITHDRAWN, undefined, 'approval.withdrawn');
  }

  /** 列表：status 可选过滤；附带发起人姓名（2026-08-27 老板反馈「发起人是乱码」——
   * requesterId 是系统内部 ID，门店看不懂；displayName 缺省回退 username）。
   * 数据范围（2026-08-28 UI 测试 #8）：无 approval:decide 的角色（如销售）只看本人发起的
   * 审批——此前全量返回，payload 业务详情对非审批人构成越权泄露面。 */
  async list(actor: JwtPayload, status?: ApprovalStatus): Promise<ApprovalItem[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: actor.sub },
      select: { userRoles: { select: { role: { select: { code: true } } } } },
    });
    const canDecide = permissionsOf(user?.userRoles.map((ur) => ur.role.code) ?? []).has(
      'approval:decide',
    );
    const items = await this.repo.findMany(status, canDecide ? undefined : actor.sub);
    const ids = [...new Set(items.map((i) => i.requesterId))];
    if (ids.length === 0) return items;
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true, username: true },
    });
    const nameOf = new Map(users.map((u) => [u.id, u.displayName || u.username]));
    return items.map((i) => ({ ...i, requesterName: nameOf.get(i.requesterId) ?? '系统' }));
  }

  /** approve/reject 公共路径：先确认存在（404），再条件迁移；决定成功后分发业务回调。
   * 回调仅在此处触发（withdraw 走 transit 不触发），确保撤回不误触流失决定回写。 */
  private async decide(
    actor: JwtPayload,
    id: string,
    to: ApprovalStatus,
    opinion: string | undefined,
    action: string,
  ): Promise<ApprovalItem> {
    const item = await this.repo.findById(id);
    if (!item) {
      throw new AppException(ErrorCode.NOT_FOUND, '审批项不存在');
    }
    const updated = await this.transit(actor, id, to, opinion, action);
    await this.decisionHandler?.(updated);
    for (const handler of this.extraHandlers) {
      await handler(updated);
    }
    // 通知发起人审批结果（V2.2a 尽力而为）：approve/reject 均触发，标题区分结论
    const verdict = to === APPROVAL_STATUS.APPROVED ? '通过' : '驳回';
    void this.safeNotify(
      () =>
        this.notifications.notify({
          userIds: [updated.requesterId],
          kind: 'approval_decided',
          title: `审批已${verdict}：${updated.type}`,
          body: opinion ? `意见：${opinion}` : undefined,
          link: '/approvals',
          sourceType: 'approval',
          sourceId: updated.id,
        }),
      `approval_decided(${updated.id})`,
    );
    return updated;
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

  /** 条件更新防竞态：updateMany({where:{id,status:'pending'}}) count=0
   * → 审批项已离开 pending（并发被决定/撤回，或重复操作）→ 409 APPROVAL_INVALID_STATE */
  private async transit(
    actor: JwtPayload,
    id: string,
    to: ApprovalStatus,
    opinion: string | undefined,
    action: string,
  ): Promise<ApprovalItem> {
    const count = await this.repo.transition(id, APPROVAL_STATUS.PENDING, {
      status: to,
      approverId: to === APPROVAL_STATUS.WITHDRAWN ? undefined : actor.sub,
      opinion,
      decidedAt: new Date(),
    });
    if (count === 0) {
      throw new AppException(ErrorCode.APPROVAL_INVALID_STATE, '审批项已离开待审状态，操作无效');
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action,
      objectType: 'approval',
      objectId: id,
      before: { status: APPROVAL_STATUS.PENDING },
      after: { status: to },
    });
    const updated = await this.repo.findById(id);
    if (!updated) {
      // 条件更新成功但读取失败：理论上不可达，防御性处理
      throw new AppException(ErrorCode.INTERNAL, '审批项状态读取失败');
    }
    return updated;
  }
}
