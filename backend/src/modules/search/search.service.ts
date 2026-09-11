import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { ASSET_KIND_LABEL, type AssetKind } from '../asset/asset.constants';
import type { JwtPayload } from '../auth/auth.types';
import { WO_STAGE_LABEL, type WorkOrderStage } from '../delivery/work-order.states';
import { isGlobalRole } from '../lead/lead.states';

/** 搜索结果项（前端 GlobalSearch 直接消费）：sub 不含联系方式（PII 边界 V2.3a）。
 * snippet=命中片段（2026-08-21 门店反馈：结果要贴近关键词，如搜「居家」直接看到「居家膜×××」
 * 那段文字）——knowledge 命中在 content 时截取关键词前后片段，其余节为 null（title/sub 已含命中上下文）。 */
export interface SearchItem {
  id: string;
  title: string;
  sub: string;
  link: string;
  snippet?: string | null;
}

export type SearchSectionType = 'leads' | 'knowledge' | 'appointments' | 'workOrders' | 'assets';

export interface SearchSection {
  type: SearchSectionType;
  items: SearchItem[];
}

export interface SearchResponse {
  q: string;
  sections: SearchSection[];
}

/** 分节可见角色（与 PERMISSION_MATRIX 同构：recorder 无 m03/m07 → 不见客资/预约节；
 * assets 为 m06:view 持有角色，V2.3b） */
export const SECTION_ROLES: Record<SearchSectionType, readonly string[]> = {
  leads: ['boss', 'store_manager', 'sales_ops'],
  knowledge: ['boss', 'store_manager', 'sales_ops', 'recorder'],
  appointments: ['boss', 'store_manager', 'sales_ops'],
  workOrders: ['boss', 'store_manager', 'sales_ops', 'recorder'],
  assets: ['boss', 'store_manager', 'sales_ops', 'recorder'],
};

/** 响应分节固定顺序：客资 → 知识 → 预约 → 施工单 → 素材 */
const SECTION_ORDER: readonly SearchSectionType[] = [
  'leads',
  'knowledge',
  'appointments',
  'workOrders',
  'assets',
];

/** 每节最多返回条数（V2.3a：全局搜索是跳转入口而非列表页） */
const SECTION_LIMIT = 5;

/** 全局搜索服务（V2.3a）：只读聚合，PrismaService 直查（S08 先例）。
 * 匹配字段——leads=leadNo/customerName/target；knowledge=title/content（全状态，状态随行）；
 * workOrders=orderNo；appointments=serviceItem/workbench/technicianName（排除已取消）；
 * assets=title/carModel/productModel（V2.3b，对内展示不限制 licensed）。
 * 数据范围：boss/店长全局；sales 仅本人（客资 ownerUserId、预约 createdBy、
 * 施工单关联本人客资）；knowledge/assets 对可见角色全量。PII：不搜手机号/微信。 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(actor: JwtPayload, q: string): Promise<SearchResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: actor.sub },
      select: { userRoles: { select: { role: { select: { code: true } } } } },
    });
    const roles = user?.userRoles.map((ur) => ur.role.code) ?? [];
    const visible = (type: SearchSectionType) => SECTION_ROLES[type].some((r) => roles.includes(r));
    if (!SECTION_ORDER.some(visible)) return { q, sections: [] }; // sys_admin 等纯技术角色：空节

    const isGlobal = isGlobalRole(roles);
    // M08 先例：recorder 对施工单为全局视野（代录/复检需要）
    const isGlobalWorkOrders = isGlobal || roles.includes('recorder');
    const contains = { contains: q, mode: 'insensitive' as const };

    // sales 施工单范围：本人客资 ID 集（work-order.service ownLeadIds 同构谓词）
    let ownLeadIds: string[] = [];
    if (visible('workOrders') && !isGlobalWorkOrders) {
      const ownLeads = await this.prisma.lead.findMany({
        where: { ownerUserId: actor.sub },
        select: { id: true },
      });
      ownLeadIds = ownLeads.map((l) => l.id);
    }

    const [leadRows, knowledgeRows, appointmentRows, workOrderRows, assetRows] = await Promise.all([
      visible('leads')
        ? this.prisma.lead.findMany({
            where: {
              OR: [{ leadNo: contains }, { customerName: contains }, { target: contains }],
              ...(isGlobal ? {} : { ownerUserId: actor.sub }),
            },
            select: { id: true, leadNo: true, customerName: true, target: true },
            orderBy: { updatedAt: 'desc' },
            take: SECTION_LIMIT,
          })
        : Promise.resolve([]),
      visible('knowledge')
        ? this.prisma.knowledgeItem.findMany({
            where: { OR: [{ title: contains }, { content: contains }] },
            select: { id: true, title: true, kind: true, status: true, content: true },
            orderBy: { updatedAt: 'desc' },
            take: SECTION_LIMIT,
          })
        : Promise.resolve([]),
      visible('appointments')
        ? this.prisma.appointment.findMany({
            where: {
              status: { not: 'cancelled' },
              OR: [
                { serviceItem: contains },
                { workbench: contains },
                { technicianName: contains },
              ],
              ...(isGlobal ? {} : { createdBy: actor.sub }),
            },
            select: { id: true, serviceItem: true, workbench: true, startAt: true },
            orderBy: { startAt: 'desc' },
            take: SECTION_LIMIT,
          })
        : Promise.resolve([]),
      visible('workOrders') && (isGlobalWorkOrders || ownLeadIds.length > 0)
        ? this.prisma.workOrder.findMany({
            where: {
              orderNo: contains,
              ...(isGlobalWorkOrders ? {} : { leadId: { in: ownLeadIds } }),
            },
            select: { id: true, orderNo: true, serviceItem: true, stage: true },
            orderBy: { updatedAt: 'desc' },
            take: SECTION_LIMIT,
          })
        : Promise.resolve([]),
      visible('assets')
        ? this.prisma.asset.findMany({
            where: {
              OR: [{ title: contains }, { carModel: contains }, { productModel: contains }],
            },
            select: { id: true, title: true, kind: true, carModel: true },
            orderBy: { createdAt: 'desc' },
            take: SECTION_LIMIT,
          })
        : Promise.resolve([]),
    ]);

    const sections: SearchSection[] = [];
    if (visible('leads') && leadRows.length > 0) {
      sections.push({
        type: 'leads',
        items: this.byRelevance(
          leadRows.map((l) => ({
            id: l.id,
            title: l.customerName || l.leadNo,
            sub: [l.leadNo, l.target].filter(Boolean).join(' · '),
            link: `/leads/${l.id}`,
          })),
          q,
        ),
      });
    }
    if (visible('knowledge') && knowledgeRows.length > 0) {
      sections.push({
        type: 'knowledge',
        items: this.byRelevance(
          knowledgeRows.map((k) => ({
            id: k.id,
            title: k.title,
            sub: `${k.kind} · ${k.status}`,
            link: '/knowledge',
            snippet: this.buildSnippet(k.content, q),
          })),
          q,
        ),
      });
    }
    if (visible('appointments') && appointmentRows.length > 0) {
      sections.push({
        type: 'appointments',
        items: this.byRelevance(
          appointmentRows.map((a) => ({
            id: a.id,
            title: a.serviceItem || a.workbench || '预约',
            sub: [this.fmtDate(a.startAt), a.workbench].filter(Boolean).join(' · '),
            link: '/appointments',
          })),
          q,
        ),
      });
    }
    if (visible('workOrders') && workOrderRows.length > 0) {
      sections.push({
        type: 'workOrders',
        items: this.byRelevance(
          workOrderRows.map((w) => ({
            id: w.id,
            title: w.orderNo,
            sub: [w.serviceItem, WO_STAGE_LABEL[w.stage as WorkOrderStage] ?? w.stage]
              .filter(Boolean)
              .join(' · '),
            link: '/work-orders',
          })),
          q,
        ),
      });
    }
    if (visible('assets') && assetRows.length > 0) {
      sections.push({
        type: 'assets',
        items: this.byRelevance(
          assetRows.map((a) => ({
            id: a.id,
            title: a.title,
            sub: [ASSET_KIND_LABEL[a.kind as AssetKind] ?? a.kind, a.carModel]
              .filter(Boolean)
              .join(' · '),
            link: '/assets',
          })),
          q,
        ),
      });
    }
    return { q, sections };
  }

  /** 关联度排序（2026-08-21 门店反馈）：标题命中 > 副行/命中片段；命中位置越靠前越相关。
   *  稳定排序——同分保持 updatedAt 倒序（查询序）。 */
  private byRelevance<T extends SearchItem>(items: T[], q: string): T[] {
    const needle = q.toLowerCase();
    const score = (it: SearchItem): number => {
      const t = it.title.toLowerCase().indexOf(needle);
      if (t >= 0) return 2 - Math.min(t, 999) / 1000;
      const s = (it.snippet ?? it.sub).toLowerCase().indexOf(needle);
      if (s >= 0) return 1 - Math.min(s, 999) / 1000;
      return 0;
    };
    return [...items].sort((a, b) => score(b) - score(a));
  }

  /** 命中片段：content 含关键词时截取前后约 15/35 字（换行压成空格，单行展示）；
   *  命中在 title 或不含关键词时返回 null（title 已展示）。 */
  private buildSnippet(content: string, q: string): string | null {
    const flat = content.replace(/\s+/g, ' ');
    const idx = flat.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return null;
    const start = Math.max(0, idx - 15);
    const end = Math.min(flat.length, idx + q.length + 35);
    return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
  }

  private fmtDate(d: Date): string {
    return d.toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
