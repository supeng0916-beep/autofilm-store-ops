/** P3-08 合成客资种子：可一键重建的合成数据集（成功/失败/沉默/异议/接管/重复派发/到店认领等分支）。
 * 零真实客户数据（S16）：电话一律 138/139 合成段、虚拟微信 ewm-、姓名「合成」前缀、地址不写真实住宅。
 * 幂等：按 leadNo 前缀 `L-00000000-` 识别合成客资先清后建（含其 Customer 与时间线事件）。
 * 用法：cd backend && npm run seed:p3（或 make seed-p3）；连跑两次结果一致。 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '@prisma/client';

import { requireDbUrl } from './db-env';

/** 合成数据固定前缀（与真实 leadNo `L-YYYYMMDD-NNNN` 不冲突，专用于识别/清理） */
const SYNTH_PREFIX = 'L-00000000-';

/** 合成角色（仅本脚本引用，不上线；口令用固定哑哈希，不参与登录） */
const SYNTH_ROLES = ['boss', 'store_manager', 'sales_ops'] as const;

/** 合成账号（username 固定便于引用；displayName 明示合成身份） */
const SYNTH_USERS = [
  { username: 'p3-synth-boss', displayName: '合成·老板', role: 'boss' },
  { username: 'p3-synth-store-manager', displayName: '合成·店长', role: 'store_manager' },
  { username: 'p3-synth-sales-a', displayName: '合成·销售甲', role: 'sales_ops' },
  { username: 'p3-synth-sales-b', displayName: '合成·销售乙', role: 'sales_ops' },
] as const;

/** 合成账号初始口令哈希（argon2 对 'p3-synth-no-login' 的哈希；仅满足列非空，不用于登录） */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$kwnuDyjFSJdqtkeTYIWqUQ$FAfHJHiXbJhJ1Q8PVBwDnknnLrwQUvVFdD9FCGjcV6Q';

/** 事件时间线基准（相对 now 往前推，保证五类时间戳与事件先后语义成立） */
const H = 60 * 60 * 1000;
const DAY = 24 * H;

interface EventSpec {
  kind: string;
  content?: Record<string, unknown>;
  operatorId?: string;
  occurredAt: Date;
}

interface LeadSpec {
  leadNo: string;
  data: Omit<Prisma.LeadUncheckedCreateInput, 'leadNo'>;
  events: EventSpec[];
}

async function main(): Promise<number> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: requireDbUrl(process.env) }),
  });
  try {
    const now = Date.now();
    const t = (offsetMs: number): Date => new Date(now - offsetMs);

    // —— 清理：按 leadNo 前缀识别合成客资，先删 Lead（级联事件），再删其 Customer ——
    const existing = await prisma.lead.findMany({
      where: { leadNo: { startsWith: SYNTH_PREFIX } },
      select: { id: true, customerId: true },
    });
    const customerIds = [...new Set(existing.map((l) => l.customerId).filter(Boolean))] as string[];
    await prisma.lead.deleteMany({ where: { leadNo: { startsWith: SYNTH_PREFIX } } });
    for (const cid of customerIds) {
      await prisma.customer.deleteMany({ where: { id: cid } });
    }

    // —— 角色 + 合成账号（幂等 upsert） ——
    for (const role of SYNTH_ROLES) {
      await prisma.role.upsert({
        where: { code: role },
        update: {},
        create: { code: role, name: role },
      });
    }
    const userIdByUsername = new Map<string, string>();
    for (const acc of SYNTH_USERS) {
      const role = await prisma.role.findUniqueOrThrow({ where: { code: acc.role } });
      const user = await prisma.user.upsert({
        where: { username: acc.username },
        update: {},
        create: { username: acc.username, displayName: acc.displayName, passwordHash: DUMMY_HASH },
      });
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: user.id, roleId: role.id } },
        update: {},
        create: { userId: user.id, roleId: role.id },
      });
      userIdByUsername.set(acc.username, user.id);
    }
    const boss = userIdByUsername.get('p3-synth-boss')!;
    const storeManager = userIdByUsername.get('p3-synth-store-manager')!;
    const salesA = userIdByUsername.get('p3-synth-sales-a')!;
    const salesB = userIdByUsername.get('p3-synth-sales-b')!;

    // 转介绍客户（sourceReferralOwnerId=salesB，供「转介绍回原维护人」样本）
    const referralCustomer = await prisma.customer.create({
      data: { name: '合成·老客（转介绍）', phone: '13900000005', sourceReferralOwnerId: salesB },
    });
    // 虚拟微信客户（供 #1 与重复派发 #12 共享 customerId，回放挂链语义）
    const virtualWechatCustomer = await prisma.customer.create({
      data: { name: '合成·客户（虚拟微信）', phone: '13900000001', wechat: 'ewm-0000000001' },
    });

    const specs: LeadSpec[] = [
      // #1 抖音线上 + 虚拟微信号（ewm-），新线索待首次触达
      {
        leadNo: `${SYNTH_PREFIX}0001`,
        data: {
          customerId: virtualWechatCustomer.id,
          sourceCategory: 'online',
          sourcePlatform: '抖音',
          acquisitionMethod: '广告私信',
          upstreamDispatchNo: 'SEED-D-0001',
          customerName: '合成·客户甲',
          phone: '13900000001',
          wechat: 'ewm-0000000001',
          wechatType: 'virtual_ewm',
          businessType: 'auto_film',
          target: '特斯拉Model Y',
          productNeed: '改色膜',
          rawNeed: '想改个颜色，先了解下',
          nextStep: '打开上游聊天内容扫码添加客户微信',
          ownerUserId: salesA,
          stage: 'new',
          finalStatus: 'active',
          upstreamDispatchAt: t(3 * DAY),
          receivedAt: t(3 * DAY - 1 * H),
          assignedAt: t(3 * DAY - 30 * 60 * 1000),
          dispatchRawText:
            '（合成）派发NO：SEED-D-0001\n日期：2026-08-11 10:20\n信息来源：抖音私信\n电话：13900000001\n微信：ewm-0000000001\n车型：特斯拉Model Y\n需求：改色膜',
          dispatchParserVersion: 1,
        },
        events: [
          {
            kind: 'dispatch_parsed',
            content: { batchId: 'seed-p3' },
            operatorId: boss,
            occurredAt: t(3 * DAY - 1 * H),
          },
          {
            kind: 'assigned',
            content: { reason: '渠道路由+池内轮询（线上池）' },
            operatorId: boss,
            occurredAt: t(3 * DAY - 30 * 60 * 1000),
          },
        ],
      },
      // #2 抖音线上，已首次触达
      {
        leadNo: `${SYNTH_PREFIX}0002`,
        data: {
          sourceCategory: 'online',
          sourcePlatform: '抖音',
          acquisitionMethod: '广告私信',
          upstreamDispatchNo: 'SEED-D-0002',
          customerName: '合成·客户乙',
          phone: '13800000002',
          wechatType: 'unknown',
          businessType: 'auto_film',
          target: '宝马X3',
          productNeed: '隐形车衣',
          rawNeed: '想贴车衣保护漆面',
          ownerUserId: salesB,
          stage: 'contacted',
          finalStatus: 'active',
          upstreamDispatchAt: t(3 * DAY),
          receivedAt: t(3 * DAY - 1 * H),
          assignedAt: t(3 * DAY - 30 * 60 * 1000),
          firstContactAttemptAt: t(2 * DAY),
        },
        events: [
          {
            kind: 'dispatch_parsed',
            content: { batchId: 'seed-p3' },
            operatorId: boss,
            occurredAt: t(3 * DAY - 1 * H),
          },
          {
            kind: 'assigned',
            content: { reason: '渠道路由+池内轮询（线上池）' },
            operatorId: boss,
            occurredAt: t(3 * DAY - 30 * 60 * 1000),
          },
          {
            kind: 'stage_changed',
            content: { from: 'new', to: 'contacted', reason: '首次触达' },
            operatorId: salesB,
            occurredAt: t(2 * DAY),
          },
        ],
      },
      // #3 抖音线上，沟通中（首触+客户回复）
      {
        leadNo: `${SYNTH_PREFIX}0003`,
        data: {
          sourceCategory: 'online',
          sourcePlatform: '抖音',
          acquisitionMethod: '广告私信',
          upstreamDispatchNo: 'SEED-D-0003',
          customerName: '合成·客户丙',
          phone: '13800000003',
          wechatType: 'unknown',
          businessType: 'auto_film',
          target: '奔驰C级',
          productNeed: '改色膜',
          rawNeed: '问下改色膜价格和工期',
          ownerUserId: salesA,
          stage: 'communicating',
          finalStatus: 'active',
          upstreamDispatchAt: t(4 * DAY),
          receivedAt: t(4 * DAY - 1 * H),
          assignedAt: t(4 * DAY - 30 * 60 * 1000),
          firstContactAttemptAt: t(3 * DAY),
          firstCustomerReplyAt: t(2 * DAY),
          lastFollowUpAt: t(2 * DAY),
        },
        events: [
          {
            kind: 'dispatch_parsed',
            content: { batchId: 'seed-p3' },
            operatorId: boss,
            occurredAt: t(4 * DAY - 1 * H),
          },
          {
            kind: 'assigned',
            content: { reason: '渠道路由+池内轮询（线上池）' },
            operatorId: boss,
            occurredAt: t(4 * DAY - 30 * 60 * 1000),
          },
          {
            kind: 'stage_changed',
            content: { from: 'new', to: 'contacted', reason: '首次触达' },
            operatorId: salesA,
            occurredAt: t(3 * DAY),
          },
          {
            kind: 'stage_changed',
            content: { from: 'contacted', to: 'communicating', reason: '客户回复进入沟通' },
            operatorId: salesA,
            occurredAt: t(2 * DAY),
          },
        ],
      },
      // #4 4S店线下线索，店长分配
      {
        leadNo: `${SYNTH_PREFIX}0004`,
        data: {
          sourceCategory: 'offline',
          sourcePlatform: '4S店',
          acquisitionMethod: '4S店介绍',
          upstreamDispatchNo: 'SEED-D-0004',
          customerName: '合成·客户丁',
          phone: '13800000004',
          wechatType: 'unknown',
          businessType: 'auto_film',
          target: '奥迪A6L',
          productNeed: '隐形车衣',
          rawNeed: '新车想贴车衣',
          ownerUserId: storeManager,
          stage: 'new',
          finalStatus: 'active',
          upstreamDispatchAt: t(2 * DAY),
          receivedAt: t(2 * DAY - 1 * H),
          assignedAt: t(2 * DAY - 30 * 60 * 1000),
        },
        events: [
          {
            kind: 'imported',
            content: { batchId: 'seed-p3' },
            operatorId: boss,
            occurredAt: t(2 * DAY - 1 * H),
          },
          {
            kind: 'assigned',
            content: { reason: '渠道路由+池内轮询（4S池）' },
            operatorId: boss,
            occurredAt: t(2 * DAY - 30 * 60 * 1000),
          },
        ],
      },
      // #5 老客户转介绍，回原维护人（salesB）
      {
        leadNo: `${SYNTH_PREFIX}0005`,
        data: {
          customerId: referralCustomer.id,
          sourceCategory: 'offline',
          sourcePlatform: '老客户转介绍',
          acquisitionMethod: '转介绍',
          upstreamDispatchNo: 'SEED-D-0005',
          customerName: '合成·客户戊',
          phone: '13900000005',
          wechatType: 'unknown',
          businessType: 'auto_film',
          target: '沃尔沃XC60',
          productNeed: '窗膜',
          rawNeed: '朋友介绍来贴窗膜',
          ownerUserId: salesB,
          stage: 'new',
          finalStatus: 'active',
          upstreamDispatchAt: t(2 * DAY),
          receivedAt: t(2 * DAY - 1 * H),
          assignedAt: t(2 * DAY - 30 * 60 * 1000),
        },
        events: [
          {
            kind: 'imported',
            content: { batchId: 'seed-p3' },
            operatorId: boss,
            occurredAt: t(2 * DAY - 1 * H),
          },
          {
            kind: 'assigned',
            content: { reason: '转介绍回原关系维护人' },
            operatorId: boss,
            occurredAt: t(2 * DAY - 30 * 60 * 1000),
          },
        ],
      },
      // #6 到店客资，未分配待接待人认领
      {
        leadNo: `${SYNTH_PREFIX}0006`,
        data: {
          sourceCategory: 'offline',
          sourcePlatform: '到店',
          acquisitionMethod: '到店',
          customerName: '合成·客户己',
          phone: '13800000006',
          wechatType: 'unknown',
          businessType: 'auto_film',
          target: '大众迈腾',
          productNeed: '改色膜',
          rawNeed: '到店咨询改色',
          ownerUserId: null,
          stage: 'new',
          finalStatus: 'active',
          receivedAt: t(1 * DAY),
        },
        events: [
          {
            kind: 'imported',
            content: { batchId: 'seed-p3' },
            operatorId: boss,
            occurredAt: t(1 * DAY),
          },
        ],
      },
      // #7 住宅膜（家膜）业务，已报价
      {
        leadNo: `${SYNTH_PREFIX}0007`,
        data: {
          sourceCategory: 'online',
          sourcePlatform: '小红书',
          acquisitionMethod: '广告私信',
          upstreamDispatchNo: 'SEED-D-0007',
          customerName: '合成·客户庚',
          phone: '13900000007',
          wechatType: 'unknown',
          businessType: 'home_film',
          target: '别墅落地玻璃',
          productNeed: '窗膜',
          rawNeed: '别墅想贴隔热窗膜',
          ownerUserId: salesA,
          stage: 'quoted',
          finalStatus: 'active',
          upstreamDispatchAt: t(5 * DAY),
          receivedAt: t(5 * DAY - 1 * H),
          assignedAt: t(5 * DAY - 30 * 60 * 1000),
          firstContactAttemptAt: t(4 * DAY),
          firstCustomerReplyAt: t(3 * DAY),
        },
        events: [
          {
            kind: 'dispatch_parsed',
            content: { batchId: 'seed-p3' },
            operatorId: boss,
            occurredAt: t(5 * DAY - 1 * H),
          },
          {
            kind: 'assigned',
            content: { reason: '渠道路由+池内轮询（线上池）' },
            operatorId: boss,
            occurredAt: t(5 * DAY - 30 * 60 * 1000),
          },
          {
            kind: 'stage_changed',
            content: { from: 'new', to: 'contacted', reason: '首次触达' },
            operatorId: salesA,
            occurredAt: t(4 * DAY),
          },
          {
            kind: 'stage_changed',
            content: { from: 'contacted', to: 'communicating', reason: '客户回复' },
            operatorId: salesA,
            occurredAt: t(3 * DAY),
          },
          {
            kind: 'stage_changed',
            content: { from: 'communicating', to: 'quoted', reason: '报价' },
            operatorId: salesA,
            occurredAt: t(2 * DAY),
          },
        ],
      },
      // #8 成交（won）
      {
        leadNo: `${SYNTH_PREFIX}0008`,
        data: {
          sourceCategory: 'online',
          sourcePlatform: '抖音',
          acquisitionMethod: '广告私信',
          upstreamDispatchNo: 'SEED-D-0008',
          customerName: '合成·客户辛',
          phone: '13800000008',
          wechatType: 'unknown',
          businessType: 'auto_film',
          target: '雷克萨斯ES',
          productNeed: '隐形车衣',
          rawNeed: '贴隐形车衣',
          ownerUserId: salesB,
          stage: 'visit_done',
          finalStatus: 'won',
          closedAt: t(1 * DAY),
          closedAmountFen: 128800,
          closeReason: '客户到店确认成交',
          upstreamDispatchAt: t(7 * DAY),
          receivedAt: t(7 * DAY - 1 * H),
          assignedAt: t(7 * DAY - 30 * 60 * 1000),
          firstContactAttemptAt: t(6 * DAY),
          firstCustomerReplyAt: t(5 * DAY),
        },
        events: [
          {
            kind: 'dispatch_parsed',
            content: { batchId: 'seed-p3' },
            operatorId: boss,
            occurredAt: t(7 * DAY - 1 * H),
          },
          {
            kind: 'assigned',
            content: { reason: '渠道路由+池内轮询（线上池）' },
            operatorId: boss,
            occurredAt: t(7 * DAY - 30 * 60 * 1000),
          },
          {
            kind: 'stage_changed',
            content: { from: 'new', to: 'contacted', reason: '首次触达' },
            operatorId: salesB,
            occurredAt: t(6 * DAY),
          },
          {
            kind: 'stage_changed',
            content: { from: 'contacted', to: 'communicating', reason: '客户回复' },
            operatorId: salesB,
            occurredAt: t(5 * DAY),
          },
          {
            kind: 'stage_changed',
            content: { from: 'communicating', to: 'visit_booked', reason: '预约到店' },
            operatorId: salesB,
            occurredAt: t(3 * DAY),
          },
          {
            kind: 'stage_changed',
            content: { from: 'visit_booked', to: 'visit_done', reason: '到店完成' },
            operatorId: salesB,
            occurredAt: t(2 * DAY),
          },
          {
            kind: 'won',
            content: { amountFen: 128800, reason: '客户到店确认成交' },
            operatorId: salesB,
            occurredAt: t(1 * DAY),
          },
        ],
      },
      // #9 流失（lost，已人工确认）
      {
        leadNo: `${SYNTH_PREFIX}0009`,
        data: {
          sourceCategory: 'online',
          sourcePlatform: '抖音',
          acquisitionMethod: '广告私信',
          upstreamDispatchNo: 'SEED-D-0009',
          customerName: '合成·客户壬',
          phone: '13900000009',
          wechatType: 'unknown',
          businessType: 'auto_film',
          target: '本田雅阁',
          productNeed: '改色膜',
          rawNeed: '问过价后没了下文',
          ownerUserId: salesA,
          stage: 'communicating',
          finalStatus: 'lost',
          lostReason: 'price',
          closedAt: t(1 * DAY),
          upstreamDispatchAt: t(10 * DAY),
          receivedAt: t(10 * DAY - 1 * H),
          assignedAt: t(10 * DAY - 30 * 60 * 1000),
          firstContactAttemptAt: t(9 * DAY),
          firstCustomerReplyAt: t(8 * DAY),
        },
        events: [
          {
            kind: 'dispatch_parsed',
            content: { batchId: 'seed-p3' },
            operatorId: boss,
            occurredAt: t(10 * DAY - 1 * H),
          },
          {
            kind: 'assigned',
            content: { reason: '渠道路由+池内轮询（线上池）' },
            operatorId: boss,
            occurredAt: t(10 * DAY - 30 * 60 * 1000),
          },
          {
            kind: 'stage_changed',
            content: { from: 'new', to: 'contacted', reason: '首次触达' },
            operatorId: salesA,
            occurredAt: t(9 * DAY),
          },
          {
            kind: 'stage_changed',
            content: { from: 'contacted', to: 'communicating', reason: '客户回复' },
            operatorId: salesA,
            occurredAt: t(8 * DAY),
          },
          {
            kind: 'churn_proposed',
            content: { reason: 'price', fromStatus: 'active' },
            operatorId: salesA,
            occurredAt: t(2 * DAY),
          },
          {
            kind: 'churn_decided',
            content: { decision: 'approved', reason: 'price' },
            operatorId: boss,
            occurredAt: t(1 * DAY),
          },
        ],
      },
      // #10 沉默（silence，nurture 档）
      {
        leadNo: `${SYNTH_PREFIX}0010`,
        data: {
          sourceCategory: 'online',
          sourcePlatform: '抖音',
          acquisitionMethod: '广告私信',
          upstreamDispatchNo: 'SEED-D-0010',
          customerName: '合成·客户癸',
          phone: '13800000010',
          wechatType: 'unknown',
          businessType: 'auto_film',
          target: '丰田凯美瑞',
          productNeed: '窗膜',
          rawNeed: '问了窗膜后沉默',
          ownerUserId: salesB,
          stage: 'communicating',
          finalStatus: 'silence',
          silenceStage: 'nurture',
          upstreamDispatchAt: t(15 * DAY),
          receivedAt: t(15 * DAY - 1 * H),
          assignedAt: t(15 * DAY - 30 * 60 * 1000),
          firstContactAttemptAt: t(14 * DAY),
          firstCustomerReplyAt: t(13 * DAY),
          lastFollowUpAt: t(13 * DAY),
        },
        events: [
          {
            kind: 'dispatch_parsed',
            content: { batchId: 'seed-p3' },
            operatorId: boss,
            occurredAt: t(15 * DAY - 1 * H),
          },
          {
            kind: 'assigned',
            content: { reason: '渠道路由+池内轮询（线上池）' },
            operatorId: boss,
            occurredAt: t(15 * DAY - 30 * 60 * 1000),
          },
          {
            kind: 'stage_changed',
            content: { from: 'new', to: 'contacted', reason: '首次触达' },
            operatorId: salesB,
            occurredAt: t(14 * DAY),
          },
          {
            kind: 'stage_changed',
            content: { from: 'contacted', to: 'communicating', reason: '客户回复' },
            operatorId: salesB,
            occurredAt: t(13 * DAY),
          },
          { kind: 'silence_marked', content: { stage: 'risk' }, occurredAt: t(12 * DAY) },
          { kind: 'silence_marked', content: { stage: 'follow_due' }, occurredAt: t(10 * DAY) },
          { kind: 'silence_marked', content: { stage: 'nurture' }, occurredAt: t(6 * DAY) },
        ],
      },
      // #11 建议流失待审批（lost_pending）
      {
        leadNo: `${SYNTH_PREFIX}0011`,
        data: {
          sourceCategory: 'online',
          sourcePlatform: '视频号',
          acquisitionMethod: '广告私信',
          upstreamDispatchNo: 'SEED-D-0011',
          customerName: '合成·客户子',
          phone: '13900000011',
          wechatType: 'unknown',
          businessType: 'auto_film',
          target: '别克GL8',
          productNeed: '改色膜',
          rawNeed: '觉得价格高，还在犹豫',
          ownerUserId: salesA,
          stage: 'communicating',
          finalStatus: 'lost_pending',
          lostReason: 'price',
          upstreamDispatchAt: t(6 * DAY),
          receivedAt: t(6 * DAY - 1 * H),
          assignedAt: t(6 * DAY - 30 * 60 * 1000),
          firstContactAttemptAt: t(5 * DAY),
          firstCustomerReplyAt: t(4 * DAY),
        },
        events: [
          {
            kind: 'dispatch_parsed',
            content: { batchId: 'seed-p3' },
            operatorId: boss,
            occurredAt: t(6 * DAY - 1 * H),
          },
          {
            kind: 'assigned',
            content: { reason: '渠道路由+池内轮询（线上池）' },
            operatorId: boss,
            occurredAt: t(6 * DAY - 30 * 60 * 1000),
          },
          {
            kind: 'stage_changed',
            content: { from: 'new', to: 'contacted', reason: '首次触达' },
            operatorId: salesA,
            occurredAt: t(5 * DAY),
          },
          {
            kind: 'stage_changed',
            content: { from: 'contacted', to: 'communicating', reason: '客户回复' },
            operatorId: salesA,
            occurredAt: t(4 * DAY),
          },
          {
            kind: 'churn_proposed',
            content: { reason: 'price', note: '客户嫌价格高', fromStatus: 'active' },
            operatorId: salesA,
            occurredAt: t(1 * DAY),
          },
        ],
      },
      // #12 连续重复派发：与 #1 同联系方式，挂链回放（dupOfLeadId 指向 #1）
      {
        leadNo: `${SYNTH_PREFIX}0012`,
        data: {
          customerId: virtualWechatCustomer.id,
          sourceCategory: 'online',
          sourcePlatform: '抖音',
          acquisitionMethod: '广告私信',
          upstreamDispatchNo: 'SEED-D-0012',
          customerName: '合成·客户甲',
          phone: '13900000001',
          wechat: 'ewm-0000000001',
          wechatType: 'virtual_ewm',
          businessType: 'auto_film',
          target: '特斯拉Model Y',
          productNeed: '改色膜',
          rawNeed: '重复派发同客户',
          ownerUserId: salesA,
          stage: 'new',
          finalStatus: 'active',
          upstreamDispatchAt: t(1 * DAY),
          receivedAt: t(1 * DAY - 1 * H),
          assignedAt: t(1 * DAY - 30 * 60 * 1000),
        },
        events: [
          {
            kind: 'dispatch_parsed',
            content: { batchId: 'seed-p3' },
            operatorId: boss,
            occurredAt: t(1 * DAY - 1 * H),
          },
          {
            kind: 'dup_linked',
            content: { primaryLeadId: `${SYNTH_PREFIX}0001` },
            operatorId: boss,
            occurredAt: t(1 * DAY - 40 * 60 * 1000),
          },
          {
            kind: 'assigned',
            content: { reason: '重复客资沿用原负责人' },
            operatorId: boss,
            occurredAt: t(1 * DAY - 30 * 60 * 1000),
          },
        ],
      },
    ];

    for (const spec of specs) {
      const lead = await prisma.lead.create({ data: { ...spec.data, leadNo: spec.leadNo } });
      for (const evt of spec.events) {
        await prisma.leadEvent.create({
          data: {
            leadId: lead.id,
            kind: evt.kind,
            operatorId: evt.operatorId,
            occurredAt: evt.occurredAt,
            content: evt.content === undefined ? undefined : (evt.content as Prisma.InputJsonValue),
          },
        });
      }
    }

    // #12 的 dupOfLeadId 回填为 #1 真实 id（合成前缀内自洽，跨 leadNo 引用）
    const primary = await prisma.lead.findUniqueOrThrow({
      where: { leadNo: `${SYNTH_PREFIX}0001` },
    });
    const dupLead = await prisma.lead.findUniqueOrThrow({
      where: { leadNo: `${SYNTH_PREFIX}0012` },
    });
    await prisma.lead.update({ where: { id: dupLead.id }, data: { dupOfLeadId: primary.id } });

    const total = await prisma.lead.count({ where: { leadNo: { startsWith: SYNTH_PREFIX } } });
    console.log(`[成功] P3 合成客资种子完成：${total} 条（前缀 ${SYNTH_PREFIX}），零真实客户数据`);
    return 0;
  } catch (err) {
    console.error(
      `[失败] P3 合成种子执行出错：${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main().then((code) => process.exit(code));
