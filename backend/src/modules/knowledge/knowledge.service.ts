import { forwardRef, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { KnowledgeItem, Prisma } from '@prisma/client';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import type { JwtPayload } from '../auth/auth.types';
import { ApprovalService } from '../approval/approval.service';
import type { CreateKnowledgeDto, UpdateKnowledgeDto } from './dto/create-knowledge.dto';
import { EmbeddingService } from './embedding.service';
import {
  APPROVAL_TYPE_KNOWLEDGE_ACTIVATE,
  KNOWLEDGE_KIND,
  KNOWLEDGE_SOURCE_DIR,
  PRICE_KINDS,
  type KnowledgeKind,
} from './knowledge.constants';
import { KnowledgeRepository } from './knowledge.repository';
import { RagService } from './rag.service';
import { canTransitionStatus, KNOWLEDGE_STATUS, type KnowledgeStatus } from './knowledge.states';

/** 知识库业务逻辑：CRUD + 版本管理 + 价格审批（P4-01）。
 * 版本策略：编辑生效条目 → 生成新版本（version+1, status=draft），旧版本自动过期；
 * 编辑 draft 条目 → 同版本覆盖。
 * 生效唯一性：同 (kind, key) 至多一条 active，服务层事务保证。
 * 审批回调：onModuleInit 注册到 ApprovalService.registerHandler，避免多模块同 token 冲突。 */
@Injectable()
export class KnowledgeService implements OnModuleInit {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly repo: KnowledgeRepository,
    @Inject(forwardRef(() => ApprovalService)) private readonly approval: ApprovalService,
    private readonly audit: AuditService,
    private readonly rag: RagService,
    private readonly embedding: EmbeddingService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.approval.registerHandler(async (item) => {
      if (item.type !== 'knowledge.activate') return;
      if (item.status !== 'approved') return;
      const payload = item.payload as { itemId: string };
      await this.executeActivate(
        { sub: item.approverId ?? item.requesterId, username: '', type: 'access' as const },
        payload.itemId,
      );
    });
  }

  /** 创建知识条目：key 由调用方传入（如 "product-dm04"），初始 status=draft, version=1 */
  async create(actor: JwtPayload, dto: CreateKnowledgeDto): Promise<KnowledgeItem> {
    const item = await this.repo.create({
      kind: dto.kind,
      key: dto.key,
      title: dto.title,
      content: dto.content,
      source: dto.source ?? null,
      licensed: dto.licensed ?? false,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      tags: (dto.tags as Prisma.InputJsonValue) ?? undefined,
      createdBy: actor.sub,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'knowledge.created',
      objectType: 'knowledge_item',
      objectId: item.id,
      after: { kind: item.kind, key: item.key, title: item.title, version: item.version },
    });
    return item;
  }

  /** AI 助手对话沉淀（2026-08-27 Q4）：登录即可发起，但强制草稿态+来源标记——
   * 生效仍走 activate（m06:approve 角色审批），价格/优惠/质保/承诺必审红线由生效关卡保证。
   * key 缺省自动生成，避免销售手工拼业务键冲突。 */
  async createFromChat(
    actor: JwtPayload,
    dto: { kind: string; title: string; content: string; key?: string; sourceLabel?: string },
  ) {
    const item = await this.repo.create({
      kind: dto.kind,
      key: dto.key?.trim() || `chat-${Date.now().toString(36)}`,
      title: dto.title,
      content: dto.content,
      source: `${dto.sourceLabel ?? 'AI 助手对话沉淀'}·${actor.username}·${new Date().toISOString().slice(0, 10)}`,
      licensed: false,
      createdBy: actor.sub,
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'knowledge.created_from_chat',
      objectType: 'knowledge_item',
      objectId: item.id,
      after: { kind: item.kind, title: item.title, from: 'agent-chat' },
    });
    return item;
  }

  /** 编辑知识条目：
   * - 原条目 status=active → 创建新版本（version+1, draft），旧版本过期
   * - 原条目 status=draft → 直接覆盖（同版本编辑） */
  async update(actor: JwtPayload, id: string, dto: UpdateKnowledgeDto): Promise<KnowledgeItem> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new AppException(ErrorCode.NOT_FOUND, '知识条目不存在');

    if (existing.status === KNOWLEDGE_STATUS.DRAFT) {
      // 同版本覆盖
      const updated = await this.repo.update(id, {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.content !== undefined && { content: dto.content }),
        ...(dto.source !== undefined && { source: dto.source }),
        ...(dto.licensed !== undefined && { licensed: dto.licensed }),
        ...(dto.expiresAt !== undefined && {
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        }),
        ...(dto.tags !== undefined && { tags: dto.tags as Prisma.InputJsonValue }),
      });
      await this.audit.record({
        actorId: actor.sub,
        actorName: actor.username,
        action: 'knowledge.updated',
        objectType: 'knowledge_item',
        objectId: id,
        after: { title: updated.title, version: updated.version },
      });
      return updated;
    }

    // 生效条目编辑 → 生成新版本
    return this.repo.tx(async (tx) => {
      // 旧版本过期
      const expired = await this.repo.transitionStatus(
        id,
        existing.status,
        KNOWLEDGE_STATUS.EXPIRED,
        tx,
      );
      if (expired === 0) {
        throw new AppException(ErrorCode.KNOWLEDGE_INVALID_STATE, '知识条目状态已变更，无法过期');
      }

      // 创建新版本
      const nextVersion = existing.version + 1;
      const created = await this.repo.create(
        {
          kind: existing.kind,
          key: existing.key,
          title: dto.title ?? existing.title,
          content: dto.content ?? existing.content,
          source: dto.source ?? existing.source,
          licensed: dto.licensed ?? existing.licensed,
          expiresAt:
            dto.expiresAt !== undefined
              ? dto.expiresAt
                ? new Date(dto.expiresAt)
                : null
              : existing.expiresAt,
          tags: (dto.tags ?? existing.tags) as Prisma.InputJsonValue,
          createdBy: actor.sub,
          version: nextVersion,
        },
        tx,
      );

      await this.audit.record({
        actorId: actor.sub,
        actorName: actor.username,
        action: 'knowledge.new_version',
        objectType: 'knowledge_item',
        objectId: created.id,
        after: { kind: created.kind, key: created.key, version: nextVersion, previousId: id },
      });
      return created;
    });
  }

  /** 生效知识条目（draft/expired → active）。
   * 价格类（kind=price）创建审批项，待审批通过后自动生效；
   * 非价格类直接生效。 */
  async activate(
    actor: JwtPayload,
    id: string,
    skipApproval?: boolean,
  ): Promise<KnowledgeItem | { approvalId: string; item: KnowledgeItem }> {
    const item = await this.repo.findById(id);
    if (!item) throw new AppException(ErrorCode.NOT_FOUND, '知识条目不存在');

    if (
      !canTransitionStatus(
        item.status as (typeof KNOWLEDGE_STATUS)[keyof typeof KNOWLEDGE_STATUS],
        KNOWLEDGE_STATUS.ACTIVE,
      )
    ) {
      throw new AppException(
        ErrorCode.KNOWLEDGE_INVALID_STATE,
        `不能从 ${item.status} 迁移到 ${KNOWLEDGE_STATUS.ACTIVE}`,
      );
    }

    // 价格类需审批（skipApproval=true 用于审批回调时直接生效）
    if (PRICE_KINDS.includes(item.kind as typeof KNOWLEDGE_KIND.PRICE) && !skipApproval) {
      const approvalItem = await this.approval.create(actor, {
        type: APPROVAL_TYPE_KNOWLEDGE_ACTIVATE,
        payload: { itemId: id, kind: item.kind, key: item.key, title: item.title },
        basis: `知识条目生效审批：${item.title}`,
      });
      await this.audit.record({
        actorId: actor.sub,
        actorName: actor.username,
        action: 'knowledge.activate_requested',
        objectType: 'knowledge_item',
        objectId: id,
        after: { approvalId: approvalItem.id },
      });
      return { approvalId: approvalItem.id, item };
    }

    // 直接生效
    return this.executeActivate(actor, id, item);
  }

  /** 执行生效：过期同键旧版本 + 当前条目激活 */
  async executeActivate(
    actor: JwtPayload,
    id: string,
    item?: KnowledgeItem,
  ): Promise<KnowledgeItem> {
    const target = item ?? (await this.repo.findById(id));
    if (!target) throw new AppException(ErrorCode.NOT_FOUND, '知识条目不存在');

    return this.repo.tx(async (tx) => {
      // 过期同键已有生效版本
      const existingActive = await tx.knowledgeItem.findFirst({
        where: { kind: target.kind, key: target.key, status: 'active', id: { not: id } },
      });
      if (existingActive) {
        const expired = await this.repo.transitionStatus(
          existingActive.id,
          'active',
          KNOWLEDGE_STATUS.EXPIRED,
          tx,
        );
        if (expired === 0) {
          throw new AppException(ErrorCode.KNOWLEDGE_INVALID_STATE, '同键已有生效版本，过期失败');
        }
      }

      // 激活当前条目
      const count = await this.repo.transitionStatus(
        id,
        target.status,
        KNOWLEDGE_STATUS.ACTIVE,
        tx,
      );
      if (count === 0) {
        throw new AppException(
          ErrorCode.KNOWLEDGE_INVALID_STATE,
          `知识条目已离开 ${target.status} 态`,
        );
      }

      const activated = await this.repo.update(
        id,
        { approvedBy: actor.sub, approvedAt: new Date() },
        tx,
      );

      await this.audit.record({
        actorId: actor.sub,
        actorName: actor.username,
        action: 'knowledge.activated',
        objectType: 'knowledge_item',
        objectId: id,
        after: { kind: activated.kind, key: activated.key, version: activated.version },
      });

      // P4-02：生效后异步向量化（不阻塞返回）
      if (this.embedding.isConfigured()) {
        this.rag.indexItem(activated.id, activated.version, activated.content).catch((err) => {
          this.logger.warn(
            `知识条目 ${activated.id} 向量化失败: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }

      return activated;
    });
  }

  /** 过期知识条目（active → expired） */
  async expire(actor: JwtPayload, id: string): Promise<KnowledgeItem> {
    const item = await this.repo.findById(id);
    if (!item) throw new AppException(ErrorCode.NOT_FOUND, '知识条目不存在');

    if (!canTransitionStatus(item.status as KnowledgeStatus, KNOWLEDGE_STATUS.EXPIRED)) {
      throw new AppException(
        ErrorCode.KNOWLEDGE_INVALID_STATE,
        `不能从 ${item.status} 迁移到 ${KNOWLEDGE_STATUS.EXPIRED}`,
      );
    }

    const count = await this.repo.transitionStatus(id, item.status, KNOWLEDGE_STATUS.EXPIRED);
    if (count === 0) {
      throw new AppException(ErrorCode.KNOWLEDGE_INVALID_STATE, `知识条目已离开 ${item.status} 态`);
    }

    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'knowledge.expired',
      objectType: 'knowledge_item',
      objectId: id,
    });
    return this.repo.findById(id) as Promise<KnowledgeItem>;
  }

  /** 按 ID 查询 */
  getById(id: string): Promise<KnowledgeItem | null> {
    return this.repo.findById(id);
  }

  /** 查生效版本（可选按 kind 过滤） */
  getActive(kind?: string): Promise<KnowledgeItem[]> {
    return this.repo.findActive(kind);
  }

  /** 查同键所有版本历史 */
  getVersions(kind: string, key: string): Promise<KnowledgeItem[]> {
    return this.repo.findByKindAndKey(kind, key);
  }

  /** 列表查询 */
  list(filters: { kind?: string; status?: string; keyword?: string }): Promise<KnowledgeItem[]> {
    return this.repo.findMany({
      kind: filters.kind as KnowledgeKind | undefined,
      status: filters.status as KnowledgeStatus | undefined,
      keyword: filters.keyword,
    });
  }

  /** 读取门店知识源原始文件（#14，只读）：三重白名单——`门店知识源/` 前缀 + 仅 .md +
   * resolve 后必须仍在 门店知识源/ 目录内（防 `..`/绝对路径穿越）。
   * 仓库根默认取运行目录上一级（dev/test 均为 backend/），WG_KNOWLEDGE_SOURCE_ROOT 可覆盖。 */
  async readSourceFile(relPath: string): Promise<{ path: string; content: string }> {
    let repoRoot = resolve(
      this.config.get<string>('WG_KNOWLEDGE_SOURCE_ROOT') ?? join(process.cwd(), '..'),
    );
    // 兼容自愈（2026-08-27 Q3）：部署包首启把根指到「门店知识源」目录本身（语义应为其父目录），
    // 拼出 门店知识源/门店知识源/… 双重路径全员 404——basename 命中即上提一级，两种指向均可读，
    // 存量安装无需改 .env（启动脚本已同步改为写父目录）
    if (basename(repoRoot) === KNOWLEDGE_SOURCE_DIR) {
      repoRoot = dirname(repoRoot);
    }
    if (!relPath.startsWith(`${KNOWLEDGE_SOURCE_DIR}/`)) {
      throw new AppException(ErrorCode.FORBIDDEN, '仅允许访问 门店知识源/ 目录下的源文件');
    }
    if (!relPath.endsWith('.md')) {
      throw new AppException(ErrorCode.FORBIDDEN, '知识源文件仅支持 .md');
    }
    const resolved = resolve(repoRoot, relPath);
    if (!resolved.startsWith(resolve(repoRoot, KNOWLEDGE_SOURCE_DIR) + sep)) {
      throw new AppException(ErrorCode.FORBIDDEN, '源文件路径越界');
    }
    try {
      return { path: relPath, content: await readFile(resolved, 'utf8') };
    } catch {
      throw new AppException(ErrorCode.NOT_FOUND, '源文件不存在');
    }
  }
}
