/** 测试客资清理（2026-08-26 O8 评测收尾 + 试用残留）：
 * 匹配规则=称呼前缀（默认 O8-）＋ 指定 leadNo 清单（默认含试用残留 L-20260825-0001）。
 * 连带清理（2026-08-27 第二轮回归 #10 补齐）：ai_tasks（refType='lead'）及其事件/反馈；
 * 挂链预约与其排期审批；客资关联施工单及其上传素材（DB 行 + uploads 文件，防下轮同内容
 * 上传被哈希 409 挡、防测试单计入技师产能）；流失审批（payload.leadId）；仅被这些客资
 * 引用的 customers 一并删除；lead_events 由外键级联自动删除；商机置空引用保留。
 *
 * 安全闸（防误删真实数据）：
 * - 默认 dry-run 只打印将删除的内容；
 * - 实删需同时满足 `--confirm` 且环境变量 CLEAN_TARGET_DB=<库名> 与连接串实际库名一致；
 * - 全程打印逐项计数，删除前后可复核（psql：SELECT count(*) FROM leads WHERE customer_name LIKE 'O8-%';）。
 *
 * 用法：
 *   cd backend
 *   WG_DATABASE_URL=postgresql://autofilm:autofilm@localhost:5432/autofilm_prod npm run clean:test-leads -- --prefix=O8-
 *   # 实删（两道闸都过才动库）：
 *   CLEAN_TARGET_DB=autofilm_prod WG_DATABASE_URL=... npm run clean:test-leads -- --confirm
 */
import 'dotenv/config';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { requireDbUrl } from './db-env';

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const PREFIX_ARG = args.find((a) => a.startsWith('--prefix='));
const PREFIX = PREFIX_ARG ? PREFIX_ARG.slice('--prefix='.length) : 'O8-';
/** 按号清理的额外客资（试用残留；可用 --extra=L-xxx 追加，可重复） */
const EXTRA_LEAD_NOS = [
  'L-20260825-0001',
  ...args.filter((a) => a.startsWith('--extra=')).map((a) => a.slice('--extra='.length)),
];

async function main(): Promise<number> {
  const url = requireDbUrl(process.env);
  const dbName = new URL(url).pathname.replace(/^\//, '');
  const target = process.env.CLEAN_TARGET_DB?.trim();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const leads = await prisma.lead.findMany({
      where: { OR: [{ customerName: { startsWith: PREFIX } }, { leadNo: { in: EXTRA_LEAD_NOS } }] },
      select: { id: true, leadNo: true, customerName: true, customerId: true, stage: true },
      orderBy: { leadNo: 'asc' },
    });
    if (leads.length === 0) {
      console.log(
        `[完成] 未匹配到测试客资（前缀 ${PREFIX} / leadNo ${EXTRA_LEAD_NOS.join(', ')}）`,
      );
      return 0;
    }
    const ids = leads.map((l) => l.id);
    console.log(`[匹配] ${leads.length} 条客资：`);
    for (const l of leads) {
      console.log(`  ${l.leadNo}  ${l.customerName ?? '(无名)'}  stage=${l.stage}`);
    }

    const tasks = await prisma.aiTask.findMany({
      where: { refType: 'lead', refId: { in: ids } },
      select: { id: true, taskType: true, status: true },
    });
    const taskIds = tasks.map((t) => t.id);
    const custIds = [...new Set(leads.map((l) => l.customerId).filter((x): x is string => !!x))];
    const custStillUsed = custIds.length
      ? await prisma.lead.findMany({
          where: { customerId: { in: custIds }, id: { notIn: ids } },
          select: { customerId: true },
        })
      : [];
    const custDeletable = custIds.filter((c) => !custStillUsed.some((l) => l.customerId === c));

    const unlink = {
      opportunity: await prisma.opportunity.count({ where: { leadId: { in: ids } } }),
      appointment: await prisma.appointment.count({ where: { leadId: { in: ids } } }),
    };
    // 客资关联的预约与其排期审批、施工单与其素材均属测试产物，一并删除（#10）
    const linkedApptIds = await prisma.appointment.findMany({
      where: { leadId: { in: ids } },
      select: { id: true },
    });

    // 施工单与其素材（#10：测试施工单计入技师产能、残留素材挡下轮哈希上传——连带删除）
    const linkedWorkOrders = await prisma.workOrder.findMany({
      where: { leadId: { in: ids } },
      select: { id: true },
    });
    const woIds = linkedWorkOrders.map((w) => w.id);
    const linkedAssets = woIds.length
      ? await prisma.asset.findMany({
          where: { workOrderId: { in: woIds } },
          select: { id: true, filePath: true, thumbPath: true },
        })
      : [];
    // JSON path in 同样不支持：逐条计数流失审批
    const churnApprovals = (
      await Promise.all(
        ids.map((leadId) =>
          prisma.approvalItem.count({
            where: { type: 'lead.churn', payload: { path: ['leadId'], equals: leadId } },
          }),
        ),
      )
    ).reduce((a, b) => a + b, 0);
    console.log(
      `[计划] leads=${ids.length}  ai_tasks=${taskIds.length}（含事件/反馈）  ` +
        `customers（无其他引用）=${custDeletable.length}  预约=${linkedApptIds.length}（含排期审批）  ` +
        `施工单=${woIds.length}  素材=${linkedAssets.length}（含文件）  流失审批=${churnApprovals}  商机置空=${unlink.opportunity}`,
    );
    console.log(
      `[库] 当前连接=${dbName}${CONFIRM ? '  模式=实删' : '  模式=dry-run（加 --confirm 实删）'}`,
    );

    if (!CONFIRM) return 0;
    if (!target || target !== dbName) {
      console.error(
        `[拒绝] 实删需环境变量 CLEAN_TARGET_DB 与连接串库名一致（当前 CLEAN_TARGET_DB=${target ?? '未设置'}，库名=${dbName}）`,
      );
      return 1;
    }

    await prisma.$transaction([
      prisma.aiTaskFeedback.deleteMany({ where: { taskId: { in: taskIds } } }),
      prisma.aiTaskEvent.deleteMany({ where: { taskId: { in: taskIds } } }),
      prisma.aiTask.deleteMany({ where: { id: { in: taskIds } } }),
      // Prisma JSON 过滤不支持 path in：逐单/逐条删除排期审批与流失审批（测试量级小）
      ...linkedApptIds.map((a) =>
        prisma.approvalItem.deleteMany({
          where: { payload: { path: ['appointmentId'], equals: a.id } },
        }),
      ),
      ...ids.map((leadId) =>
        prisma.approvalItem.deleteMany({
          where: { type: 'lead.churn', payload: { path: ['leadId'], equals: leadId } },
        }),
      ),
      prisma.appointment.deleteMany({ where: { id: { in: linkedApptIds.map((a) => a.id) } } }),
      // 素材 DB 行先删（文件在事务后尽力清理，失败只警告不回滚）
      prisma.asset.deleteMany({ where: { id: { in: linkedAssets.map((a) => a.id) } } }),
      prisma.opportunity.updateMany({ where: { leadId: { in: ids } }, data: { leadId: null } }),
      // 施工单连带删除（#10：孤儿单会持续计入技师产能统计）
      prisma.workOrder.deleteMany({ where: { id: { in: woIds } } }),
      prisma.lead.deleteMany({ where: { id: { in: ids } } }),
      prisma.customerRefId.deleteMany({ where: { customerId: { in: custDeletable } } }),
      prisma.customer.deleteMany({ where: { id: { in: custDeletable } } }),
    ]);
    // 素材文件清理（尽力而为：路径相对 uploads 目录）
    for (const a of linkedAssets) {
      for (const rel of [a.filePath, a.thumbPath]) {
        if (!rel) continue;
        const abs = resolve(process.env.WG_UPLOAD_DIR ?? 'uploads', rel);
        await rm(abs, { force: true }).catch(() => undefined);
      }
    }
    console.log(
      `[完成] 已删除 ${ids.length} 条客资及其 AI 任务（${taskIds.length} 条）/事件/反馈，客户 ${custDeletable.length} 条`,
    );
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[失败]', err);
    process.exit(1);
  },
);
