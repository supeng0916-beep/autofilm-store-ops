import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, WorkOrder } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { VisitService } from '../aftercare/visit.service';
import type { JwtPayload } from '../auth/auth.types';
import { KNOWLEDGE_KIND } from '../knowledge/knowledge.constants';
import { KnowledgeService } from '../knowledge/knowledge.service';
import type { ConfirmNode } from './work-order.repository';
import { WorkOrderRepository } from './work-order.repository';
import { assertTechnicianSkill } from './technician-skill';
import { WO_STAGE, canTransitionWoStage, type WorkOrderStage } from './work-order.states';
import type { BusinessType } from './delivery.constants';
import type {
  AddAbnormalDto,
  CareNotesConfirmDto,
  CaseRequestDto,
  CreateWorkOrderDto,
  DeliverDto,
  ListWorkOrdersQueryDto,
  ReworkDto,
  StageActionDto,
} from './dto/work-order.dto';

interface CareNotes {
  draft: string;
  sources: Array<{ title: string; source: string | null }>;
  generatedAt: string;
  confirmed?: { by: string; byName: string; at: string; content: string };
}

/** 施工单服务（P5-04/05/06，M08）：阶段状态机 + 三真人确认节点 + 案例回流。
 * 确定性代码（S11）：无任何模型判定路径——质检/交付只由真人操作落库；
 * AI 边界由测试锁定（work-order 边界测试断言 ai-dispatch 无施工质检类 taskType）。 */
@Injectable()
export class WorkOrderService {
  private readonly logger = new Logger(WorkOrderService.name);

  constructor(
    private readonly repo: WorkOrderRepository,
    private readonly audit: AuditService,
    private readonly knowledge: KnowledgeService,
    private readonly config: ConfigService,
    private readonly visit: VisitService, // M09：交付钩子生成回访计划（AftercareModule 导出）
  ) {}

  /** 创建施工单：预约必须已店长确认（P5-03 未确认排期不生效），字段快照自预约 */
  async create(actor: JwtPayload, dto: CreateWorkOrderDto): Promise<WorkOrder> {
    const appointment = await this.repo.findAppointment(dto.appointmentId);
    if (!appointment) throw new AppException(ErrorCode.NOT_FOUND, '预约不存在');
    if (appointment.status === 'cancelled') {
      throw new AppException(ErrorCode.WORK_ORDER_INVALID_STATE, '预约已取消，不能建立施工单');
    }
    if (!appointment.managerConfirmed) {
      throw new AppException(
        ErrorCode.WORK_ORDER_INVALID_STATE,
        '排期未经店长确认，不能建立施工单（P5-03 未确认排期不生效）',
      );
    }
    // 2026-08-28 bug4：同一预约只允许一张施工单——返工在原单上走（返工→重新自检→复检），
    // 重复建单会让技师统计与产值重复计数
    const existing = await this.repo.findFirstByAppointmentId(dto.appointmentId);
    if (existing) {
      throw new AppException(
        ErrorCode.WORK_ORDER_INVALID_STATE,
        `该预约已有施工单（${existing.orderNo}），返工请在原单上发起，不要重复建单`,
      );
    }
    // 2026-08-28 bug3（方案A）：技师必填——预约已指定则以预约为准；否则必须建单时选定。
    // 无技师施工单会在人机团队忙闲统计中「隐身」，且责任无法追溯，故服务端硬拦截。
    const technicianName =
      appointment.technicianName ?? (dto.technicianName?.trim() ? dto.technicianName.trim() : null);
    if (!technicianName) {
      throw new AppException(
        ErrorCode.VALIDATION_FAILED,
        '该预约未指定技师，请先在施工单选择技师再建单',
      );
    }
    // 2026-08-28 P1：建单路径接入技能池硬校验（与预约创建/技师替换同规则）——
    // 此前只有「预约指定技师」路径校验，建单现场选人时单一工种技师可被派给任意业务单，
    // 技能矩阵失效且污染技师产能统计。校验最终落单人（预约已指定技师同样复检，停用技师不再接新单）。
    await assertTechnicianSkill(
      technicianName,
      appointment.businessType as BusinessType | null,
      (name) => this.repo.findTechnicianByName(name),
    );

    // 技师关联化（批次3 T3）：前端传 ID 优先；仅姓名时反查回填（存量兼容）
    const technicianId =
      dto.technicianId?.trim() ||
      (await this.repo.findTechnicianByName(technicianName ?? ''))?.id ||
      null;
    const order = await this.repo.create({
      orderNo: await this.repo.nextOrderNo(),
      appointmentId: appointment.id,
      customerId: appointment.customerId,
      opportunityId: appointment.opportunityId,
      leadId: appointment.leadId,
      serviceItem: appointment.serviceItem,
      businessType: appointment.businessType,
      ...(dto.homeSurvey ? { homeSurvey: dto.homeSurvey } : {}),
      ...(technicianId ? { technicianId } : {}),
      workbench: appointment.workbench,
      technicianName,
      stage: WO_STAGE.PENDING,
      recorderId: actor.sub,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'work_order.created',
      objectType: 'work_order',
      objectId: order.id,
      after: { orderNo: order.orderNo, appointmentId: appointment.id },
    });
    return order;
  }

  /** 列表：boss/店长/记录员全局；销售仅本人客资关联（PERMISSION_MATRIX M08 🔶 本人客户） */
  async list(actor: JwtPayload, query: ListWorkOrdersQueryDto): Promise<WorkOrder[]> {
    const roles = await this.repo.userRoleCodes(actor.sub);
    const isGlobal =
      roles.includes('boss') || roles.includes('store_manager') || roles.includes('recorder');
    if (isGlobal) return this.repo.findMany(query.stage);
    const leadIds = await this.repo.ownedLeadIds(actor.sub);
    const all = await this.repo.findMany(query.stage);
    return all.filter((w) => w.leadId !== null && leadIds.includes(w.leadId));
  }

  /** 详情：传 actor 时执行 M08 数据范围——非全局角色仅可见本人客资关联（越权按不存在处理） */
  async get(id: string, actor?: JwtPayload): Promise<WorkOrder> {
    const order = await this.repo.findById(id);
    if (!order) throw new AppException(ErrorCode.NOT_FOUND, '施工单不存在');
    if (actor) {
      const roles = await this.repo.userRoleCodes(actor.sub);
      const isGlobal =
        roles.includes('boss') || roles.includes('store_manager') || roles.includes('recorder');
      if (!isGlobal) {
        const owned = await this.repo.ownedLeadIds(actor.sub);
        if (!order.leadId || !owned.includes(order.leadId)) {
          throw new AppException(ErrorCode.NOT_FOUND, '施工单不存在');
        }
      }
    }
    return order;
  }

  /** 入场开工：pending → in_progress（记录员） */
  async start(actor: JwtPayload, id: string): Promise<WorkOrder> {
    return this.advance(actor, id, WO_STAGE.IN_PROGRESS, {}, 'work_order.started');
  }

  /** 技师自检完成（记录员代录真人确认，P5-05 节点一） */
  async selfCheck(actor: JwtPayload, id: string, dto: StageActionDto): Promise<WorkOrder> {
    const node = this.confirmNode(actor, dto);
    return this.advance(
      actor,
      id,
      WO_STAGE.SELF_CHECK_DONE,
      {
        selfCheck: this.json(node),
        ...(node.occurredAt ? { backfilled: true, backfillForAt: node.occurredAt } : {}),
      },
      'work_order.self_checked',
      dto,
    );
  }

  /** 店长复检（P5-05 节点二） */
  async recheck(actor: JwtPayload, id: string, dto: StageActionDto): Promise<WorkOrder> {
    const node = this.confirmNode(actor, dto);
    return this.advance(
      actor,
      id,
      WO_STAGE.RECHECK_DONE,
      {
        recheck: this.json(node),
        ...(node.occurredAt ? { backfilled: true, backfillForAt: node.occurredAt } : {}),
      },
      'work_order.rechecked',
      dto,
    );
  }

  /** 返工（P5-05）：退回施工中，原因独立记录可回溯 */
  async rework(actor: JwtPayload, id: string, dto: ReworkDto): Promise<WorkOrder> {
    const order = await this.get(id);
    if (!canTransitionWoStage(order.stage as WorkOrderStage, WO_STAGE.IN_PROGRESS)) {
      throw new AppException(ErrorCode.WORK_ORDER_INVALID_STATE, `阶段 ${order.stage} 不允许返工`);
    }
    const record = {
      reason: dto.reason,
      note: dto.note,
      by: actor.sub,
      byName: actor.username,
      at: new Date().toISOString(),
      ...(dto.occurredAt ? { occurredAt: dto.occurredAt } : {}),
    };
    const records = [...this.asArray(order.reworkRecords), record];
    const count = await this.repo.transitionStage(
      id,
      [WO_STAGE.SELF_CHECK_DONE, WO_STAGE.RECHECK_DONE],
      { stage: WO_STAGE.IN_PROGRESS, rework: true, reworkRecords: this.json(records) },
    );
    if (count === 0) {
      throw new AppException(ErrorCode.WORK_ORDER_INVALID_STATE, '施工单阶段已变化，返工失败');
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'work_order.rework',
      objectType: 'work_order',
      objectId: id,
      after: { reason: dto.reason },
    });
    return this.get(id);
  }

  /** 客户交付确认（P5-05 节点三，店长）；M09：交付即自动生成 7/30 天回访计划 */
  async deliver(actor: JwtPayload, id: string, dto: DeliverDto): Promise<WorkOrder> {
    const deliveredAt = dto.occurredAt ?? new Date().toISOString();
    const order = await this.advance(
      actor,
      id,
      WO_STAGE.DELIVERED,
      {
        deliveredAt: new Date(deliveredAt),
        deliveredBy: actor.sub,
        ...(dto.warrantyRef ? { warrantyRef: dto.warrantyRef } : {}),
        ...(dto.occurredAt ? { backfilled: true, backfillForAt: dto.occurredAt } : {}),
      },
      'work_order.delivered',
      dto,
    );
    // M09：交付即排 7/30 天回访（planForWorkOrder 幂等；失败不阻断交付——回访是尽力而为，
    // 但不静默吞掉：与 appointment.service 审批载荷异常同口径走 logger.warn 留痕）
    try {
      await this.visit.planForWorkOrder(order.id, order.customerId, new Date(deliveredAt));
    } catch (e) {
      this.logger.warn(`回访计划生成失败（不阻断交付）: ${(e as Error).message}`);
    }
    return order;
  }

  /** 照片：multipart 文件 → 本地存储，路径入库（P5-04；文件实体不入 git/库）。
   * 2026-08-17 复核改 multipart：base64 受全局 JSON 100kb 上限限制，真实照片无法上传 */
  async addPhoto(
    actor: JwtPayload,
    id: string,
    file: Express.Multer.File,
    note?: string,
  ): Promise<WorkOrder> {
    const order = await this.get(id);
    if (order.stage === WO_STAGE.DELIVERED) {
      throw new AppException(ErrorCode.WORK_ORDER_INVALID_STATE, '已交付施工单不能补照片');
    }
    const dir = this.config.get<string>('WG_UPLOAD_DIR') ?? 'uploads';
    await mkdir(dir, { recursive: true });
    const ext = path.extname(file.originalname) || '.jpg';
    const fileName = `${order.orderNo}-${Date.now()}-${randomBytes(3).toString('hex')}${ext}`;
    const filePath = path.join(dir, fileName);
    await writeFile(filePath, file.buffer);
    const entry = {
      path: filePath,
      originalName: file.originalname,
      note,
      by: actor.sub,
      at: new Date().toISOString(),
    };
    const updated = await this.repo.update(id, {
      photos: this.json([...this.asArray(order.photos), entry]),
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'work_order.photo_added',
      objectType: 'work_order',
      objectId: id,
      after: { path: filePath },
    });
    return updated;
  }

  /** 异常记录追加（P5-04） */
  async addAbnormal(actor: JwtPayload, id: string, dto: AddAbnormalDto): Promise<WorkOrder> {
    const order = await this.get(id);
    const entry = {
      description: dto.description,
      by: actor.sub,
      byName: actor.username,
      at: new Date().toISOString(),
      ...(dto.occurredAt ? { occurredAt: dto.occurredAt } : {}),
    };
    return this.repo.update(id, { abnormal: this.json([...this.asArray(order.abnormal), entry]) });
  }

  /** 养护说明草稿（P5-05）：从生效知识确定性拼装并带来源引用——AI/模型不参与 */
  async draftCareNotes(actor: JwtPayload, id: string): Promise<WorkOrder> {
    const order = await this.get(id);
    const items = await this.repo.findCareKnowledge();
    const sources = items.map((k) => ({ title: k.title, source: k.source }));
    const lines = [
      `【${order.serviceItem ?? '本次施工'}】交付养护说明（草稿，须人工确认后方可交付客户）`,
      ...items.map((k) => `- ${k.title}：${k.content}`),
      items.length === 0 ? '-（知识库暂无生效的质保/品牌类条目，请先维护 M06 知识库）' : '',
    ].filter(Boolean);
    const care: CareNotes = {
      draft: lines.join('\n'),
      sources,
      generatedAt: new Date().toISOString(),
    };
    const existing = this.asCareNotes(order.careNotes);
    return this.repo.update(id, {
      careNotes: this.json({ ...care, confirmed: existing?.confirmed }),
    });
  }

  /** 养护说明人工确认（P5-05：草稿由人确认，确认人/时间留痕） */
  async confirmCareNotes(
    actor: JwtPayload,
    id: string,
    dto: CareNotesConfirmDto,
  ): Promise<WorkOrder> {
    const order = await this.get(id);
    const care = this.asCareNotes(order.careNotes);
    if (!care) {
      throw new AppException(ErrorCode.WORK_ORDER_INVALID_STATE, '先生成养护说明草稿再确认');
    }
    const updated = await this.repo.update(id, {
      careNotes: this.json({
        ...care,
        confirmed: {
          by: actor.sub,
          byName: actor.username,
          at: new Date().toISOString(),
          content: dto.content,
        },
      }),
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'work_order.care_notes_confirmed',
      objectType: 'work_order',
      objectId: id,
    });
    return updated;
  }

  /** 案例授权询问（P5-06）：仅交付后可询问；授权→知识库案例草稿（licensed），未授权→零知识写入 */
  async caseRequest(actor: JwtPayload, id: string, dto: CaseRequestDto): Promise<WorkOrder> {
    const order = await this.get(id);
    if (order.stage !== WO_STAGE.DELIVERED) {
      throw new AppException(ErrorCode.WORK_ORDER_INVALID_STATE, '交付完成后才能询问案例授权');
    }
    const request = {
      authorized: dto.authorized,
      method: dto.method,
      note: dto.note,
      by: actor.sub,
      byName: actor.username,
      at: new Date().toISOString(),
    };
    const updated = await this.repo.update(id, { caseRequest: this.json(request) });

    let knowledgeId: string | undefined;
    if (dto.authorized) {
      const content = [
        `服务项目：${order.serviceItem ?? '-'}`,
        `技师：${order.technicianName ?? '-'}`,
        `工位：${order.workbench ?? '-'}`,
        `照片：${this.asArray(order.photos).length} 张（见施工单 ${order.orderNo}）`,
        order.warrantyRef ? `质保：${order.warrantyRef}` : '',
        `来源施工单：${order.orderNo}`,
      ]
        .filter(Boolean)
        .join('\n');
      const item = await this.knowledge.create(actor, {
        kind: KNOWLEDGE_KIND.CASE,
        key: `case-${order.orderNo.toLowerCase()}`,
        title: `${order.serviceItem ?? '施工'}案例 ${order.orderNo}`,
        content,
        source: `work_order:${order.orderNo}`,
        licensed: true,
        tags: { orderNo: order.orderNo, appointmentId: order.appointmentId ?? '' },
      });
      knowledgeId = item.id;
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'work_order.case_request',
      objectType: 'work_order',
      objectId: id,
      after: { ...request, knowledgeId },
    });
    return updated;
  }

  // —— 内部 ——

  /** 阶段推进公共路径：状态机校验 + 条件更新 + 审计 */
  private async advance(
    actor: JwtPayload,
    id: string,
    to: WorkOrderStage,
    extra: Prisma.WorkOrderUpdateInput,
    action: string,
    dto?: StageActionDto | DeliverDto,
  ): Promise<WorkOrder> {
    const order = await this.get(id);
    if (!canTransitionWoStage(order.stage as WorkOrderStage, to)) {
      throw new AppException(
        ErrorCode.WORK_ORDER_INVALID_STATE,
        `阶段不允许从 ${order.stage} 迁移到 ${to}`,
      );
    }
    const count = await this.repo.transitionStage(id, [order.stage as WorkOrderStage], {
      stage: to,
      ...extra,
    });
    if (count === 0) {
      throw new AppException(ErrorCode.WORK_ORDER_INVALID_STATE, '施工单阶段已变化，操作失败');
    }
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action,
      objectType: 'work_order',
      objectId: id,
      before: { stage: order.stage },
      after: { stage: to, note: dto?.note },
    });
    return this.get(id);
  }

  /** 确认节点结构（真人确认人与时间；occurredAt=受控补录原时间） */
  private confirmNode(actor: JwtPayload, dto: StageActionDto): ConfirmNode {
    return {
      by: actor.sub,
      byName: actor.username,
      at: new Date().toISOString(),
      ...(dto.occurredAt ? { occurredAt: dto.occurredAt } : {}),
      ...(dto.note ? { note: dto.note } : {}),
    };
  }

  private asArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
  }

  /** Prisma Json 字段写入统一转换（字段结构由本服务保证） */
  private json(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
  }

  private asCareNotes(value: unknown): CareNotes | null {
    return value ? (value as unknown as CareNotes) : null;
  }
}
