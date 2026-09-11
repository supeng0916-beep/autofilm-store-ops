import { createHash, randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import type { Asset } from '@prisma/client';
import sharp from 'sharp';
import { z } from 'zod';

import { AuditService } from '../../common/audit';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { PrismaService } from '../../prisma/prisma.service';
import { AiTaskRegistry } from '../ai-dispatch/ai-dispatch.registry';
import type { JwtPayload } from '../auth/auth.types';
import { NotificationService } from '../notification/notification.service';
import {
  ASSET_IMAGE_MIME,
  ASSET_IMAGE_MAX_BYTES,
  ASSET_THUMB_SIZE,
  ASSET_VIDEO_MIME,
  ASSET_VIDEO_MAX_BYTES,
} from './asset.constants';
import type {
  BatchUploadMetaDto,
  ListAssetsQueryDto,
  UpdateAssetDto,
  UploadAssetDto,
} from './dto/asset.dto';

/** MIME → 扩展名兜底：原始文件名缺扩展时仍保证 sendFile 能推断 Content-Type（V2.3b） */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
};

/** 待入库文件夹（v1.5 T12）扩展名白名单 → MIME 映射；其他扩展名不入库，移 inbox-failed/ */
const INBOX_EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

/** watch 导入系统身份（T12）：Asset.createdBy 为普通 String 无 FK，用固定串标明来源
 * （审计 actorId 允许系统值先例） */
const WATCH_ACTOR: JwtPayload = { sub: 'watch-import', username: 'watch-import', type: 'access' };

/** 入库管线元数据：kind/title 必填，其余可选字段与单文件上传一致（v1.5 T11） */
export interface IngestMeta {
  kind: string;
  title: string;
  carModel?: string;
  productModel?: string;
  stage?: string;
  technicianName?: string;
  source?: string;
  licensed?: boolean;
  workOrderId?: string;
}

/** asset.suggest_tags 输出 schema（v1.5 T13）：tags ≤8 个、单项 ≤30 字。
 * 即回调校验依据（沿用注册表机制）；输出只落 ai_tasks.output 建议态，人工采纳后才写素材 tags。 */
export const AssetSuggestTagsOutputSchema = z.object({
  tags: z.array(z.string().max(30)).max(8),
});

/** 批量上传统计报告（v1.5 T11）：逐文件归类，不抛错 */
export interface BatchReport {
  /** 入库成功的素材（id + title） */
  created: Array<{ id: string; title: string }>;
  /** hash 与存量重复而跳过的原始文件名 */
  skippedDuplicate: string[];
  /** 白名单/大小限制拒绝的文件及原因 */
  failed: Array<{ name: string; reason: string }>;
}

/** 素材库服务（V2.3b Task2，v1.5 T11 管线化）：
 * ingestFile 共享管线（hash 去重 → 落盘 → 缩略图 → 入库），单文件/批量同源；
 * 文件实体不入 git/库：落 WG_UPLOAD_DIR/assets/ 子目录，路径入库；
 * licensed 默认 false，对外引用须人工标记授权（与知识库语义一致）。 */
@Injectable()
export class AssetService implements OnModuleInit {
  private readonly logger = new Logger(AssetService.name);
  /** 扫描互斥（T12）：定时触发与手动直调不并发，上一轮未结束则本轮直接放弃 */
  private scanning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationService,
    private readonly registry: AiTaskRegistry,
  ) {}

  /** asset.suggest_tags 注册（v1.5 T13，A09 待批准发布）：业务模块 OnModuleInit 登记先例
   * （lead-ai/marketing-ai 同源）；skill 随包分发，生产启用需老板批准，此处仅登记。 */
  onModuleInit(): void {
    this.registry.register({
      taskType: 'asset.suggest_tags',
      skillName: 'skill-asset-suggest-tags',
      outputSchema: AssetSuggestTagsOutputSchema,
      deadlineSeconds: 60,
      constraints: { boundary: '仅输出标签数组，不编造事实，不访问工具' },
    });
  }

  /** 素材入库管线（v1.5）：hash 去重 → 落盘 → 缩略图（仅图片）→ 元数据入库。
   * 重复 hash 返回 {duplicate:true} 不入库；调用方决定报告口径
   * （单文件抛 CONFLICT，批量记入 skippedDuplicate）。 */
  async ingestFile(
    actor: JwtPayload,
    meta: IngestMeta,
    file: { buffer: Buffer; originalname: string; mimetype: string },
  ): Promise<{ asset?: Asset; duplicate?: boolean }> {
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    const existing = await this.prisma.asset.findUnique({
      where: { fileHash },
      select: { id: true },
    });
    if (existing) return { duplicate: true };

    const dir = path.join(this.config.get<string>('WG_UPLOAD_DIR') ?? 'uploads', 'assets');
    await mkdir(dir, { recursive: true });
    const ext = path.extname(file.originalname) || MIME_EXT[file.mimetype] || '';
    // 时间戳用 base36：十进制毫秒数恒为 1[3-9] 开头 11+ 位数字串，会命中出适配层
    // 手机号正则（A04 maskDeep）导致提交 AI 的文件名被替换为 [PHONE]（v1.5 T13）；
    // base36 段时间戳 ≤8 位，结构上不可能形成 11 位连续数字串。
    const fileName = `asset-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}${ext}`;
    const filePath = path.join(dir, fileName);
    await writeFile(filePath, file.buffer);

    const mediaType = ASSET_VIDEO_MIME.test(file.mimetype)
      ? 'video'
      : ASSET_IMAGE_MIME.test(file.mimetype)
        ? 'image'
        : 'document';

    // 缩略图仅图片：sharp resize(256) webp；失败不阻塞入库（thumbPath 留空，thumb 端点回退原图）
    let thumbPath: string | null = null;
    if (mediaType === 'image') {
      const candidate = path.join(dir, `${fileName}.thumb.webp`);
      try {
        await sharp(file.buffer).resize(ASSET_THUMB_SIZE).webp().toFile(candidate);
        thumbPath = candidate;
      } catch {
        thumbPath = null;
        await rm(candidate, { force: true }).catch(() => undefined);
      }
    }

    let asset: Asset;
    try {
      asset = await this.prisma.asset.create({
        data: {
          kind: meta.kind,
          title: meta.title,
          filePath,
          fileHash,
          mediaType,
          ...(thumbPath ? { thumbPath } : {}),
          ...(meta.carModel ? { carModel: meta.carModel } : {}),
          ...(meta.productModel ? { productModel: meta.productModel } : {}),
          ...(meta.stage ? { stage: meta.stage } : {}),
          ...(meta.technicianName ? { technicianName: meta.technicianName } : {}),
          ...(meta.source ? { source: meta.source } : {}),
          licensed: meta.licensed ?? false,
          ...(meta.workOrderId ? { workOrderId: meta.workOrderId } : {}),
          createdBy: actor.sub,
        },
      });
    } catch (err) {
      // 并发同 hash 竞争：唯一索引兜底（P2002），回收已落盘文件后按重复报告
      if ((err as { code?: string }).code === 'P2002') {
        await rm(filePath, { force: true }).catch(() => undefined);
        if (thumbPath) await rm(thumbPath, { force: true }).catch(() => undefined);
        return { duplicate: true };
      }
      throw err;
    }

    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'asset.uploaded',
      objectType: 'asset',
      objectId: asset.id,
      after: { kind: meta.kind, title: meta.title, path: filePath },
    });
    return { asset };
  }

  /** 上传（单文件入口）：走共享管线，重复内容抛 CONFLICT 409 */
  async upload(actor: JwtPayload, dto: UploadAssetDto, file: Express.Multer.File): Promise<Asset> {
    const result = await this.ingestFile(
      actor,
      {
        kind: dto.kind,
        title: dto.title,
        carModel: dto.carModel,
        productModel: dto.productModel,
        stage: dto.stage,
        technicianName: dto.technicianName,
        source: dto.source,
        licensed: dto.licensed ?? false,
        workOrderId: dto.workOrderId,
      },
      file,
    );
    if (result.duplicate) {
      throw new AppException(ErrorCode.CONFLICT, '素材已存在（文件内容重复）');
    }
    return result.asset!;
  }

  /** 批量上传（v1.5 T11）：逐文件走管线，不抛错，汇总 BatchReport。
   * 图片超 20MB / 视频超 1GB → failed；重复 hash → skippedDuplicate；成功 → created。
   * rejected 为控制器层 MIME 白名单拒收清单（multer fileFilter 无法直接产出报告项）。 */
  async uploadBatch(
    actor: JwtPayload,
    meta: BatchUploadMetaDto,
    files: Express.Multer.File[],
    rejected: Array<{ name: string; reason: string }> = [],
  ): Promise<BatchReport> {
    const report: BatchReport = { created: [], skippedDuplicate: [], failed: [...rejected] };
    for (const file of files) {
      const maxBytes = ASSET_VIDEO_MIME.test(file.mimetype)
        ? ASSET_VIDEO_MAX_BYTES
        : ASSET_IMAGE_MAX_BYTES;
      if (file.size > maxBytes) {
        report.failed.push({ name: file.originalname, reason: '超出大小限制' });
        continue;
      }
      // title 口径：原文件名去扩展名（比统一前缀+序号更直观，brief 定稿口径）
      const ext = path.extname(file.originalname);
      const title = path.basename(file.originalname, ext) || file.originalname;
      const result = await this.ingestFile(
        actor,
        // carModel（2026-08-28）：本批共用，网页批量上传按车型分组
        { kind: meta.kind, title, ...(meta.carModel ? { carModel: meta.carModel } : {}) },
        file,
      );
      if (result.duplicate) {
        report.skippedDuplicate.push(file.originalname);
      } else if (result.asset) {
        report.created.push({ id: result.asset.id, title: result.asset.title });
      }
    }
    return report;
  }

  /** 待入库文件夹扫描（v1.5 T12，每 5 分钟）：WG_IMPORT_WATCH_DIR 未配置则关闭。
   * 目录不存在 → mkdir 后返回（首次部署不报错）；递归收集常规文件，按扩展名白名单映射 MIME，
   * 逐个走 ingestFile 管线；成功/重复移 watchDir 同级 inbox-processed/YYYY-MM/，失败移 inbox-failed/，
   * 有处理结果时发一条汇总通知给 boss（尽力而为）。定时任务内自捕获，异常只记日志不外抛。 */
  @Interval(300_000)
  async scanInbox(): Promise<void> {
    const watchDir = this.config.get<string>('WG_IMPORT_WATCH_DIR');
    if (!watchDir || this.scanning) return;
    this.scanning = true;
    try {
      await this.scanInboxOnce(watchDir);
    } catch (err) {
      this.logger.error(`watch 导入扫描失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.scanning = false;
    }
  }

  /** 单轮扫描：收集 → 逐文件入库分拣 → 汇总通知 */
  private async scanInboxOnce(watchDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(watchDir, { recursive: true, withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(watchDir, { recursive: true });
        return;
      }
      throw err;
    }

    const processedRoot = path.join(path.dirname(watchDir), 'inbox-processed');
    const processedDir = path.join(processedRoot, this.localYearMonth());
    const failedDir = path.join(path.dirname(watchDir), 'inbox-failed');
    // 防御：分拣目录正常是 watchDir 同级（扫描范围外），前缀过滤防误配下二次处理
    const skipPrefixes = [`${processedRoot}${path.sep}`, `${failedDir}${path.sep}`];

    let created = 0;
    let duplicate = 0;
    let failed = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const src = path.join(entry.parentPath, entry.name);
      if (skipPrefixes.some((p) => src.startsWith(p))) continue;

      // 子文件夹分组（2026-08-28）：第一级目录名即车型——访达按车型建文件夹整堆拖入即可，
      // 无需按「车型-序号」批量重命名（访达批量重命名为空格分隔，对不上连字符约定）。
      // parentPath 为绝对路径（实测 readdir recursive 语义）→ 先相对化再取第一级
      const rel = path.relative(watchDir, entry.parentPath);
      const firstSeg = rel.split(path.sep)[0];
      const folderModel =
        rel && rel !== '.' && !rel.startsWith('..') && firstSeg && firstSeg !== '.'
          ? firstSeg.slice(0, 100)
          : undefined;

      const mimetype = INBOX_EXT_MIME[path.extname(entry.name).toLowerCase()];
      let outcome: 'created' | 'duplicate' | 'failed';
      if (!mimetype) {
        outcome = 'failed'; // 扩展名白名单外
      } else {
        try {
          outcome = await this.ingestOneFromInbox(src, entry.name, mimetype, folderModel);
        } catch (err) {
          outcome = 'failed';
          this.logger.warn(
            `watch 导入异常（${entry.name}）：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (outcome === 'created') created += 1;
      else if (outcome === 'duplicate') duplicate += 1;
      else failed += 1;

      try {
        await this.moveTo(src, outcome === 'failed' ? failedDir : processedDir);
      } catch (err) {
        // 分拣移动失败不影响入库结果：文件留在原处，下轮扫描 hash 去重保证不重入并重试移动
        this.logger.warn(
          `watch 导入分拣移动失败（${entry.name}），下轮重试：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (created + duplicate + failed > 0) {
      // 汇总通知（尽力而为）：NotificationService 内部自捕获，不会阻塞主流程
      await this.notifications.notifyRoleHolders(['boss'], {
        kind: 'asset_import_done',
        title: `素材入库完成：新增 ${created} / 跳过重复 ${duplicate} / 失败 ${failed}`,
        link: '/assets',
        sourceType: 'asset_import',
        sourceId: this.localDateKey(),
      });
    }
  }

  /** watch 单文件入库（T12）：整读 buffer 复用 ingestFile 管线。
   * 取舍：不为超大视频单独做流式 hash+copyFile 路径——大小上限与批量上传一致
   * （图片 20MB / 视频 1GB），0 字节或超限按 failed 分拣；门店场景视频体量可控，以可靠为先。 */
  private async ingestOneFromInbox(
    src: string,
    fileName: string,
    mimetype: string,
    folderModel?: string,
  ): Promise<'created' | 'duplicate' | 'failed'> {
    const buffer = await readFile(src);
    if (buffer.byteLength === 0) {
      this.logger.warn(`watch 导入跳过（0 字节文件）：${fileName}`);
      return 'failed';
    }
    const maxBytes = ASSET_VIDEO_MIME.test(mimetype)
      ? ASSET_VIDEO_MAX_BYTES
      : ASSET_IMAGE_MAX_BYTES;
    if (buffer.byteLength > maxBytes) {
      this.logger.warn(`watch 导入跳过（超出大小限制）：${fileName}`);
      return 'failed';
    }
    // title 口径同批量上传：原文件名去扩展名；kind 默认完工案例（老板 2026-08-25 口径：
    // 门店 inbox 投递即完工案例档案；施工过程照走网页上传并显式选类型）
    const title = path.basename(fileName, path.extname(fileName)) || fileName;
    // 车型解析（2026-08-28 扩展）：子文件夹名优先（按车型建文件夹整堆拖入的小白路径）；
    // 收件箱根目录的文件沿用「车型-序号.ext」文件名前缀约定（无连字符不解析；≤100 字对齐 DTO）
    const dash = fileName.indexOf('-');
    const fileModel = dash > 0 ? fileName.slice(0, Math.min(dash, 100)) : undefined;
    const carModel = folderModel ?? fileModel;
    const result = await this.ingestFile(
      WATCH_ACTOR,
      { kind: 'finished', title, ...(carModel ? { carModel } : {}), source: 'watch-import' },
      { buffer, originalname: fileName, mimetype },
    );
    return result.duplicate ? 'duplicate' : 'created';
  }

  /** 分拣移动（T12）：rename 到目标目录（mkdir recursive）；同名冲突加时间戳+随机后缀 */
  private async moveTo(src: string, destDir: string): Promise<void> {
    await mkdir(destDir, { recursive: true });
    const base = path.basename(src);
    let dest = path.join(destDir, base);
    try {
      await rename(src, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        const ext = path.extname(base);
        const stem = path.basename(base, ext);
        dest = path.join(destDir, `${stem}-${Date.now()}-${randomBytes(3).toString('hex')}${ext}`);
        await rename(src, dest);
      } else {
        throw err;
      }
    }
  }

  /** 本地日期键 YYYY-MM-DD（通知 sourceId，门店本地时区口径，同 ai-cost todayKey 手法） */
  private localDateKey(): string {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  /** 本地月份键 YYYY-MM（processed 目录分层） */
  private localYearMonth(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  /** 编辑（PATCH /assets/:id，v1.5 T11）：仅更新传入字段，留痕 asset.updated */
  async update(actor: JwtPayload, id: string, dto: UpdateAssetDto): Promise<Asset> {
    const existing = await this.prisma.asset.findUnique({ where: { id } });
    if (!existing) throw new AppException(ErrorCode.NOT_FOUND, '素材不存在');

    const data: Partial<
      Pick<Asset, 'tags' | 'licensed' | 'title' | 'carModel' | 'productModel' | 'stage'>
    > = {};
    if (dto.tags !== undefined) data.tags = dto.tags;
    if (dto.licensed !== undefined) data.licensed = dto.licensed;
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.carModel !== undefined) data.carModel = dto.carModel;
    if (dto.productModel !== undefined) data.productModel = dto.productModel;
    if (dto.stage !== undefined) data.stage = dto.stage;

    const asset = await this.prisma.asset.update({ where: { id }, data });
    const keys = Object.keys(data) as Array<keyof typeof data>;
    const before = Object.fromEntries(keys.map((k) => [k, existing[k]]));
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'asset.updated',
      objectType: 'asset',
      objectId: id,
      before,
      after: data,
    });
    return asset;
  }

  /** 批量授权（PATCH /assets/batch，2026-08-25 老板反馈：逐个点开关太麻烦）：
   * updateMany 按 id 命中计数返回，不因个别 id 不存在而整批失败；单条审计留痕。 */
  async updateLicensedBatch(
    actor: JwtPayload,
    ids: string[],
    licensed: boolean,
  ): Promise<{ updated: number }> {
    const { count } = await this.prisma.asset.updateMany({
      where: { id: { in: ids } },
      data: { licensed },
    });
    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'asset.licensed_batch',
      objectType: 'asset',
      objectId: `batch:${count}`,
      after: { licensed, requested: ids.length, updated: count },
    });
    return { updated: count };
  }

  /** 删除（DELETE /assets/:id，2026-08-25 老板需求：手动剔除误传/过期素材）：
   * 库记录删除；物理文件与缩略图挪入回收目录（文件名加 id 前缀防同名覆盖，
   * 误删可人工找回），文件缺失不阻断删除。 */
  async remove(actor: JwtPayload, id: string): Promise<void> {
    const existing = await this.prisma.asset.findUnique({ where: { id } });
    if (!existing) throw new AppException(ErrorCode.NOT_FOUND, '素材不存在');
    await this.prisma.asset.delete({ where: { id } });

    const trashDir = path.join(
      this.config.get<string>('WG_UPLOAD_DIR') ?? 'uploads',
      '.trash-deleted',
    );
    await mkdir(trashDir, { recursive: true });
    for (const p of [existing.filePath, existing.thumbPath]) {
      if (!p) continue;
      try {
        await rename(p, path.join(trashDir, `${existing.id}-${path.basename(p)}`));
      } catch {
        this.logger.warn(`删除素材时文件移动失败（残留待人工清理）：${p}`);
      }
    }

    await this.audit.record({
      actorId: actor.sub,
      actorName: actor.username,
      action: 'asset.deleted',
      objectType: 'asset',
      objectId: id,
      before: { title: existing.title, path: existing.filePath },
    });
  }

  /** 缩略图取件（GET /assets/:id/thumb，v1.5 T11）：有 thumbPath 用之，否则回退原文件 */
  async getThumb(id: string): Promise<{ filePath: string }> {
    const asset = await this.prisma.asset.findUnique({ where: { id } });
    if (!asset) throw new AppException(ErrorCode.NOT_FOUND, '素材不存在');
    return { filePath: asset.thumbPath ?? asset.filePath };
  }

  /** 列表：kind 筛选 + keyword（title/carModel ILIKE），新上传在前 */
  list(query: ListAssetsQueryDto): Promise<Asset[]> {
    const contains = query.keyword
      ? { contains: query.keyword, mode: 'insensitive' as const }
      : undefined;
    return this.prisma.asset.findMany({
      where: {
        ...(query.kind ? { kind: query.kind } : {}),
        ...(contains ? { OR: [{ title: contains }, { carModel: contains }] } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 详情（含 filePath，供前端经 /assets/:id/file 取文件） */
  getById(id: string): Promise<Asset | null> {
    return this.prisma.asset.findUnique({ where: { id } });
  }
}
