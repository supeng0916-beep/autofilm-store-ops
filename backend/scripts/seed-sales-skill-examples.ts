/** M02 阶段二 Task5：销售助手技能 v2 瘦身——被删的 4 个详例迁入知识库（kind=case，active）。
 * 这些示例原在 skill-sales-agent SKILL.md v1 的「示例」段，瘦身后保留 1 个形态锚定、
 * 4 个迁到这里人工可见可审；知识预检索按关键词命中时可把它们注入 knowledgeContext 作形态参考。
 * 模式：直连 Prisma（同 seed.ts 的 adapter 用法）；kind=case 非价格类，直接 active 不走审批。
 * 用法（backend 目录）：npm run seed:sales-examples（数据库连接串取 backend/.env WG_DATABASE_URL）
 * 幂等：按 key upsert——已存在则对齐字段，不存在则创建，重复运行结果一致。 */
import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { requireDbUrl } from './db-env';

const MIGRATION_SOURCE = '技能示例迁移（2026-09-07）';

interface ExampleSeed {
  key: string;
  title: string;
  /** content = 一行用途说明 + 示例全文（输入/输出） */
  content: string;
}

/** 4 条 = SKILL.md v1 被删示例的原文转写（输出 JSON 逐字保留） */
const EXAMPLES: ExampleSeed[] = [
  {
    key: 'skill-example-quote-no-source',
    title: '示例：报价无来源时的标准应答',
    content: [
      '用途：报价/优惠类问题知识库无命中时的标准应答形态——不给任何参考数字，固定引导人工确认。',
      '输入 message："奥迪A8 贴膜多少钱"（无 knowledgeContext）',
      '输出：{"reply":"这个价格口径我这边没有依据，请找店长或老板确认后再报"}',
    ].join('\n'),
  },
  {
    key: 'skill-example-web-search',
    title: '示例：行业动态联网搜索的回答形态',
    content: [
      '用途：行业/同行动态类问题触发 web_search 后的带来源回答形态——要点提炼＋来源标注＋括注仅供参考。',
      '输入 message："最近本地同行贴膜店有什么动态？"（触发 web_search）',
      '输出：{"reply":"查了下公开网络（仅供参考）：①本地多家贴膜店在推隐形车衣升级不加价活动（来源：列表网本地站）；②本地媒体在做2026本地贴膜店选购指南盘点（来源：太平洋汽车网）。建议结合到店客户反馈再判断竞品价格战力度。","suggestions":["演示品牌官方最近有什么新动作","帮我把这些整理成一条朋友圈"]}',
    ].join('\n'),
  },
  {
    key: 'skill-example-asset-licensed',
    title: '示例：图片素材命中的应答形态（已授权）',
    content: [
      '用途：用户要图片素材且 assetCandidates 命中已授权素材时的应答形态——选 id 放入 assets 并在 reply 说明图片内容。',
      '输入 message："把车衣报价图发给我"（assetCandidates 命中「车衣报价图」）',
      '输出：{"reply":"已找到店内的车衣报价图（已授权），就在下方，点击可放大查看。需要的话可以直接保存发给客户。","assets":["cmt2…"],"suggestions":["车衣双膜套餐现在什么价","帮我写条带报价图的到店邀约"]}',
    ].join('\n'),
  },
  {
    key: 'skill-example-asset-unlicensed',
    title: '示例：图片素材命中的应答形态（未授权提醒）',
    content: [
      '用途：assetCandidates 命中未授权素材时的应答形态——id 可选入 assets，但 reply 必须提醒对外发送前先确认授权。',
      '输入 message："发两张领克09的完工案例给客户看看"（assetCandidates 命中未授权案例图）',
      '输出：{"reply":"找到两张领克09完工案例，就在下方。注意：素材还未授权，对外发送前请先确认。","assets":["cmt9…"],"suggestions":["帮我写条配案例图的跟进话术","领克09 车衣报价多少"]}',
    ].join('\n'),
  },
];

async function main(): Promise<number> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: requireDbUrl(process.env) }),
  });
  try {
    // createdBy 沿知识库口径取创建人账号 id（无外键约束，缺失时退化为可追溯字面量）
    const manager = await prisma.user.findUnique({ where: { username: 'ph-store-manager' } });
    const createdBy = manager?.id ?? 'seed:skill-example-migration';

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const item of EXAMPLES) {
      const existing = await prisma.knowledgeItem.findFirst({ where: { key: item.key } });
      const data = {
        kind: 'case',
        title: item.title,
        content: item.content,
        source: MIGRATION_SOURCE,
        licensed: true,
        status: 'active',
      };
      if (!existing) {
        await prisma.knowledgeItem.create({ data: { ...data, key: item.key, createdBy } });
        created++;
        console.log(`[新建] case ${item.key}`);
        continue;
      }
      const same =
        existing.kind === data.kind &&
        existing.title === data.title &&
        existing.content === data.content &&
        existing.source === data.source &&
        existing.licensed === data.licensed &&
        existing.status === data.status;
      if (same) {
        unchanged++;
        console.log(`[跳过] case ${item.key}（已一致）`);
        continue;
      }
      await prisma.knowledgeItem.update({ where: { id: existing.id }, data });
      updated++;
      console.log(`[更新] case ${item.key}`);
    }
    const total = await prisma.knowledgeItem.count({
      where: { key: { startsWith: 'skill-example-' }, status: 'active' },
    });
    console.log(
      `本次：新建 ${created} 条，更新 ${updated} 条，跳过 ${unchanged} 条；skill-example-* 生效共 ${total} 条`,
    );
    return 0;
  } catch (err) {
    console.error('[失败]', err instanceof Error ? err.message : err);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main().then((code) => process.exit(code));
