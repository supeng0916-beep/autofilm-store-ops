import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/modules/auth/auth.service';
import {
  pickInspirationsForContext,
  VideoInspirationService,
} from '../src/modules/marketing/video-inspiration.service';
import { buildApp } from './setup';
import { uniqueUsername } from './helpers/unique';

interface InspirationRow {
  id: string;
  platform: string;
  title: string;
  hookText: string;
  structure: string;
  rhythm: string | null;
  metrics: string | null;
  tags: string[];
  isPeer: boolean;
  sourceUrl: string | null;
  note: string | null;
  status: string;
  createdBy: string;
}

/** 纯函数单测最小行形状（无 DB、无 Nest 装配） */
interface RankRow {
  title: string;
  tags: string[];
  createdAt: Date;
}

const mkRow = (over: Partial<RankRow>): RankRow => ({
  title: '无题',
  tags: [],
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  ...over,
});

/** 检索排序纯逻辑（M02 批次B）：tags 与支柱关键词交集优先、title contains 兜底。
 * 支柱是账号定位里的长串（如「产品科普（膜的种类/真假鉴别）」），标签是短词
 * （如「产品科普」）——匹配口径：按分隔符拆支柱成关键词，与标签做等值/双向子串匹配。 */
describe('pickInspirationsForContext 纯逻辑（无 DB）', () => {
  const pillars = ['产品科普（膜的种类/真假鉴别/参数怎么读）', '施工过程（标准化流程/细节特写）'];

  it('tags 交集优先：命中数多者在前，同命中数按 createdAt 倒序，无交集不入选', () => {
    const two = mkRow({
      tags: ['产品科普', '膜的种类'],
      createdAt: new Date('2026-08-01T00:00:00Z'),
    });
    const one = mkRow({ tags: ['施工过程'], createdAt: new Date('2026-08-20T00:00:00Z') });
    const none = mkRow({ tags: ['促销优惠'], createdAt: new Date('2026-08-30T00:00:00Z') });
    // two 命中 2 个关键词但更旧——命中数优先于新鲜度
    expect(pickInspirationsForContext([none, one, two], pillars)).toEqual([two, one]);
  });

  it('支柱关键词按分隔符拆分；短标签与关键词双向子串匹配（「避坑」命中「行业揭秘避坑」）', () => {
    const row = mkRow({ tags: ['避坑'] });
    const out = pickInspirationsForContext([row], ['行业揭秘避坑（贴膜内幕/低价猫腻/选购指南）']);
    expect(out).toEqual([row]);
    // 关键词子串命中标签方向：标签「贴膜内幕怎么讲」包含关键词「贴膜内幕」
    const long = mkRow({ tags: ['贴膜内幕怎么讲'] });
    expect(pickInspirationsForContext([long], ['行业揭秘避坑（贴膜内幕/低价猫腻）'])).toEqual([
      long,
    ]);
  });

  it('单字标签不参与交集（噪音大）；无命中且无提示词 → 空结果', () => {
    expect(
      pickInspirationsForContext([mkRow({ tags: ['坑'] })], ['行业揭秘避坑（贴膜内幕）']),
    ).toEqual([]);
  });

  it('title contains keywordHint 兜底：排在一切 tags 交集之后', () => {
    const tagHit = mkRow({ tags: ['产品科普'], title: '随便什么标题' });
    const titleHit = mkRow({
      tags: ['无关'],
      title: '新车贴膜避坑指南',
      createdAt: new Date('2026-08-30T00:00:00Z'),
    });
    const neither = mkRow({
      tags: ['无关'],
      title: '完全无关标题',
      createdAt: new Date('2026-08-25T00:00:00Z'),
    });
    expect(pickInspirationsForContext([neither, titleHit, tagHit], pillars, '避坑指南')).toEqual([
      tagHit,
      titleHit,
    ]);
    // 兜底行也不会越过交集行被 limit 挤掉交集行
    expect(pickInspirationsForContext([neither, titleHit, tagHit], pillars, '避坑指南', 1)).toEqual(
      [tagHit],
    );
  });

  it('无支柱（空数组）时仅剩 title 兜底；limit 截断到前 N 条', () => {
    const a = mkRow({ title: '演示品牌DM10实测', createdAt: new Date('2026-08-02T00:00:00Z') });
    const b = mkRow({ title: '演示品牌DM10横评', createdAt: new Date('2026-08-09T00:00:00Z') });
    const c = mkRow({ title: '不相关' });
    expect(pickInspirationsForContext([a, b, c], [], '演示品牌DM10')).toEqual([b, a]);
    expect(pickInspirationsForContext([a, b], [], '演示品牌DM10', 1)).toEqual([b]);
    expect(pickInspirationsForContext([a, b], [], undefined, 0)).toEqual([]);
  });
});

/** 灵感库集成测试（M02 · 批次B）：CRUD 契约 + 权限 + 检索服务（真实 DB）。
 * 权限口径同内容台账：写 = m02:edit ∪ m02:approve，读 = m02:view；recorder 一律 403。 */
describe('灵感库 CRUD（M02 · 批次B）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let svc: VideoInspirationService;
  const password = 'S3cure-Passw0rd!';
  // 每次运行唯一 tag：测试库数据跨运行残留，标题含 tag 隔离与清扫
  const tag = Math.random().toString(36).slice(2, 8);
  let bossToken = '';
  let bossId = '';
  let managerToken = '';
  let salesToken = '';
  let recorderToken = '';

  const mkUser = async (uname: string, role: string): Promise<{ token: string; id: string }> => {
    const roleRow = await prisma.role.findUniqueOrThrow({ where: { code: role } });
    const user = await prisma.user.create({
      data: {
        username: uname,
        passwordHash: await auth.hashPassword(password),
        displayName: uname,
      },
    });
    await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
    const res = await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/login')
      .send({ username: uname, password });
    return { token: (res.body as { accessToken: string }).accessToken, id: user.id };
  };

  const api = () => request(app.getHttpServer() as Server);

  const createInspiration = (token: string, extra: Record<string, unknown>) =>
    api()
      .post('/api/v1/marketing/video/inspirations')
      .set('Authorization', `Bearer ${token}`)
      .send(extra);

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    svc = app.get(VideoInspirationService);
    for (const code of ['boss', 'store_manager', 'sales_ops', 'recorder']) {
      await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code } });
    }
    const boss = await mkUser(uniqueUsername('m02vi_boss'), 'boss');
    bossToken = boss.token;
    bossId = boss.id;
    managerToken = (await mkUser(uniqueUsername('m02vi_manager'), 'store_manager')).token;
    salesToken = (await mkUser(uniqueUsername('m02vi_sales'), 'sales_ops')).token;
    recorderToken = (await mkUser(uniqueUsername('m02vi_recorder'), 'recorder')).token;
  });

  afterAll(async () => {
    // 清理口径：按标题含 tag 清扫（仅测试库清扫本套件残留）
    await prisma.videoInspiration.deleteMany({ where: { title: { contains: tag } } });
    await app.close();
  });

  it('POST 创建 → 201：拆解字段落库，tags/isPeer/status 缺省', async () => {
    const created = await createInspiration(bossToken, {
      platform: '抖音',
      title: `演示品牌DM10施工钩子拆解${tag}`,
      hookText: '前3秒：新车落地直接开进施工位，不谈参数先谈对比',
      structure: '钩子→痛点→施工特写→报价→引导关注',
      rhythm: '每5秒切镜，前15秒两次对比',
      metrics: '50w 赞/1.2w 评',
      tags: [`产品科普${tag}`, `施工过程${tag}`],
      isPeer: true,
      sourceUrl: 'https://v.douyin.com/abc123',
      note: '老板指定的对标样本',
    }).expect(201);
    const row = created.body as InspirationRow;
    expect(row.id).toBeTruthy();
    expect(row.hookText).toBe('前3秒：新车落地直接开进施工位，不谈参数先谈对比');
    expect(row.structure).toBe('钩子→痛点→施工特写→报价→引导关注');
    expect(row.tags).toEqual([`产品科普${tag}`, `施工过程${tag}`]);
    expect(row.isPeer).toBe(true);
    expect(row.status).toBe('active');
    expect(row.createdBy).toBe(bossId);

    // 最小入参：可选项全缺省（tags 空、非同行、active、拆解可空项为 null）
    const minimal = await createInspiration(bossToken, {
      platform: '视频号',
      title: `最小入参样本${tag}`,
      hookText: '开头即高潮',
      structure: '总分总',
    }).expect(201);
    const m = minimal.body as InspirationRow;
    expect(m.tags).toEqual([]);
    expect(m.isPeer).toBe(false);
    expect(m.status).toBe('active');
    expect(m.rhythm).toBeNull();
    expect(m.metrics).toBeNull();
    expect(m.sourceUrl).toBeNull();
    expect(m.note).toBeNull();

    // 必填四项缺一 → 400；tags 超 6 个 → 400；空串标签 → 400；纯空格 platform → 400
    const base = { title: `校验${tag}`, hookText: '钩子', structure: '结构' };
    await createInspiration(bossToken, base).expect(400);
    await createInspiration(bossToken, { ...base, platform: '抖音', title: undefined }).expect(400);
    await createInspiration(bossToken, { ...base, platform: '抖音', hookText: undefined }).expect(
      400,
    );
    await createInspiration(bossToken, { ...base, platform: '抖音', structure: undefined }).expect(
      400,
    );
    await createInspiration(bossToken, {
      platform: '抖音',
      title: `超标签${tag}`,
      hookText: '钩子',
      structure: '结构',
      tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    }).expect(400);
    await createInspiration(bossToken, {
      platform: '抖音',
      title: `空标签${tag}`,
      hookText: '钩子',
      structure: '结构',
      tags: ['  '],
    }).expect(400);
    await createInspiration(bossToken, {
      platform: '   ',
      title: `空平台${tag}`,
      hookText: '钩子',
      structure: '结构',
    }).expect(400);
  });

  it('GET 列表：active 优先沉底 archived，组内 createdAt 倒序；keyword/platform/isPeer 过滤', async () => {
    // 本用例自隔离：先清扫本套件此前用例的行，列表断言只面对 A/B/C
    await prisma.videoInspiration.deleteMany({ where: { title: { contains: tag } } });
    // 三条样本：A 早、B 晚（稍后归档）、C 中
    const a = await createInspiration(bossToken, {
      platform: '抖音',
      title: `排序样本A${tag}`,
      hookText: `钩子甲${tag}`,
      structure: '结构',
      isPeer: true,
    }).expect(201);
    const b = await createInspiration(bossToken, {
      platform: '抖音',
      title: `排序样本B${tag}`,
      hookText: '钩子乙',
      structure: '结构',
    }).expect(201);
    const c = await createInspiration(bossToken, {
      platform: '视频号',
      title: `排序样本C${tag}`,
      hookText: '钩子丙',
      structure: '结构',
    }).expect(201);
    const aId = (a.body as InspirationRow).id;
    const bId = (b.body as InspirationRow).id;
    const cId = (c.body as InspirationRow).id;
    // createdAt 同毫秒无法分辨：直接改成固定时刻保证确定性
    await prisma.videoInspiration.update({
      where: { id: aId },
      data: { createdAt: new Date('2026-08-01T00:00:00.000Z') },
    });
    await prisma.videoInspiration.update({
      where: { id: bId },
      data: { createdAt: new Date('2026-08-20T00:00:00.000Z') },
    });
    await prisma.videoInspiration.update({
      where: { id: cId },
      data: { createdAt: new Date('2026-08-10T00:00:00.000Z') },
    });

    const mine = async (query = ''): Promise<InspirationRow[]> => {
      const res = await api()
        .get(`/api/v1/marketing/video/inspirations${query}`)
        .set('Authorization', `Bearer ${bossToken}`)
        .expect(200);
      return res.body as InspirationRow[];
    };

    // 组内 createdAt 倒序：B(08-20) → C(08-10) → A(08-01)
    expect((await mine()).map((r) => r.id)).toEqual([bId, cId, aId]);

    // 归档 B 后：active 组（C→A）在前，archived 组沉底——即使 B 最新
    await api()
      .patch(`/api/v1/marketing/video/inspirations/${bId}`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ status: 'archived' })
      .expect(200);
    expect((await mine()).map((r) => r.id)).toEqual([cId, aId, bId]);

    // keyword：命中标题（A）或钩子（C）
    expect(
      (await mine('?keyword=' + encodeURIComponent(`排序样本A${tag}`))).map((r) => r.id),
    ).toEqual([aId]);
    expect((await mine('?keyword=' + encodeURIComponent('钩子丙'))).map((r) => r.id)).toEqual([
      cId,
    ]);
    // platform 过滤
    expect((await mine('?platform=' + encodeURIComponent('视频号'))).map((r) => r.id)).toEqual([
      cId,
    ]);
    // isPeer 过滤（仅 A 标了同行）
    expect((await mine('?isPeer=true')).map((r) => r.id)).toEqual([aId]);
    expect((await mine('?isPeer=false')).map((r) => r.id)).toEqual([cId, bId]);
  });

  it('PATCH note/status/tags → 200；拆解字段不可改；不存在 404；空改 400', async () => {
    const created = await createInspiration(bossToken, {
      platform: '抖音',
      title: `待更新样本${tag}`,
      hookText: '原钩子',
      structure: '原结构',
      tags: [`旧标签${tag}`],
    }).expect(201);
    const id = (created.body as InspirationRow).id;

    const updated = await api()
      .patch(`/api/v1/marketing/video/inspirations/${id}`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ note: `已复用${tag}`, status: 'archived', tags: [`产品科普${tag}`, '施工过程'] })
      .expect(200);
    const row = updated.body as InspirationRow;
    expect(row.note).toBe(`已复用${tag}`);
    expect(row.status).toBe('archived');
    expect(row.tags).toEqual([`产品科普${tag}`, '施工过程']);
    // 拆解字段不在更新面（DTO 不接收，zod 剥离后为空 → 400）
    expect(row.hookText).toBe('原钩子');
    expect(row.title).toBe(`待更新样本${tag}`);

    await api()
      .patch(`/api/v1/marketing/video/inspirations/${id}`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ hookText: '偷改钩子', title: '偷改标题' })
      .expect(400);
    await api()
      .patch(`/api/v1/marketing/video/inspirations/${id}`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({})
      .expect(400);
    // 非法 status → 400；tags 超 6 → 400
    await api()
      .patch(`/api/v1/marketing/video/inspirations/${id}`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ status: 'deleted' })
      .expect(400);
    await api()
      .patch(`/api/v1/marketing/video/inspirations/${id}`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ tags: ['1', '2', '3', '4', '5', '6', '7'] })
      .expect(400);
    await api()
      .patch('/api/v1/marketing/video/inspirations/nonexistent-id')
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ note: 'x' })
      .expect(404);
  });

  it('权限：recorder 一律 403；sales_ops(m02:edit) 与 store_manager(m02:approve) 可写', async () => {
    await api()
      .get('/api/v1/marketing/video/inspirations')
      .set('Authorization', `Bearer ${recorderToken}`)
      .expect(403);
    await createInspiration(recorderToken, {
      platform: '抖音',
      title: `越权样本${tag}`,
      hookText: '钩子',
      structure: '结构',
    }).expect(403);

    // 销售持 m02:edit：可登记
    const bySales = await createInspiration(salesToken, {
      platform: '抖音',
      title: `销售登记样本${tag}`,
      hookText: '销售拆的钩子',
      structure: '销售拆的结构',
    }).expect(201);
    // 店长仅持 m02:approve（无 m02:edit）——写口径为并集，可更新
    await api()
      .patch(`/api/v1/marketing/video/inspirations/${(bySales.body as InspirationRow).id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ note: '店长复核' })
      .expect(200);
  });

  it('searchForContext：仅 active、tags 交集优先、title 兜底、limit 截断、紧凑投影', async () => {
    // 自隔离：清扫本套件此前用例的行（检索断言只面对本用例五行样本）
    await prisma.videoInspiration.deleteMany({ where: { title: { contains: tag } } });
    // r1 命中 2 个支柱关键词（最旧）；r2 命中 1 个（次旧）；r3 无交集但标题命中提示词（最新）；
    // r4 完全无关（第二新）；r5 命中但已归档（不得注入 AI 上下文）
    const mk = async (title: string, tags: string[], createdAt: string, status = 'active') => {
      const res = await createInspiration(bossToken, {
        platform: '抖音',
        title,
        hookText: '钩子',
        structure: '结构',
        tags,
      }).expect(201);
      const row = res.body as InspirationRow;
      await prisma.videoInspiration.update({
        where: { id: row.id },
        data: { createdAt: new Date(createdAt), ...(status === 'archived' ? { status } : {}) },
      });
    };
    // 提示词 `标题兜底${tag}` 含本次运行 tag：不命中历史残留行，用例自隔离
    await mk(
      `检索科普拆解一${tag}`,
      [`产品科普${tag}`, `膜的种类${tag}`],
      '2026-08-01T00:00:00.000Z',
    );
    await mk(`检索施工纪录二${tag}`, [`施工过程${tag}`], '2026-08-02T00:00:00.000Z');
    await mk(`检索标题兜底${tag}三`, ['无关标签'], '2026-09-01T00:00:00.000Z');
    await mk(`检索完全无关四${tag}`, ['无关标签'], '2026-08-30T00:00:00.000Z');
    await mk(`检索归档样本五${tag}`, [`产品科普${tag}`], '2026-08-05T00:00:00.000Z', 'archived');

    const pillars = [
      `产品科普${tag}（膜的种类/真假鉴别）`,
      `施工过程${tag}（标准化流程/细节特写）`,
    ];
    const items = await svc.searchForContext(pillars, `标题兜底${tag}`, 3);
    // 交集组在前（r1 两命中 > r2 一命中，且 r1 更旧——命中数优先于新鲜度），
    // title 兜底第三；r4（最新但无命中）与 r5（归档）不入选
    expect(items.map((v) => v.title)).toEqual([
      `检索科普拆解一${tag}`,
      `检索施工纪录二${tag}`,
      `检索标题兜底${tag}三`,
    ]);
    // 紧凑投影：不含 note/sourceUrl/createdBy/id 等人工与内部字段
    expect(Object.keys(items[0]).sort()).toEqual(
      ['hookText', 'isPeer', 'metrics', 'platform', 'rhythm', 'structure', 'tags', 'title'].sort(),
    );
    // limit 截断：交集组优先占位
    const two = await svc.searchForContext(pillars, `标题兜底${tag}`, 2);
    expect(two.map((v) => v.title)).toEqual([`检索科普拆解一${tag}`, `检索施工纪录二${tag}`]);
    // 无提示词：只剩交集组（归档的 r5 仍不出现）
    const onlyTags = await svc.searchForContext(pillars);
    expect(onlyTags.map((v) => v.title)).toEqual([`检索科普拆解一${tag}`, `检索施工纪录二${tag}`]);
  });

  it('审计 video_inspiration.created/updated 留痕', async () => {
    const created = await createInspiration(bossToken, {
      platform: '抖音',
      title: `审计样本${tag}`,
      hookText: '钩子',
      structure: '结构',
    }).expect(201);
    const id = (created.body as InspirationRow).id;

    const createdAudit = await prisma.auditLog.findFirst({
      where: { objectType: 'video_inspiration', objectId: id, action: 'video_inspiration.created' },
    });
    expect(createdAudit).not.toBeNull();
    expect(createdAudit!.actorId).toBe(bossId);
    expect(createdAudit!.after as object).toMatchObject({
      title: `审计样本${tag}`,
      platform: '抖音',
    });

    await api()
      .patch(`/api/v1/marketing/video/inspirations/${id}`)
      .set('Authorization', `Bearer ${bossToken}`)
      .send({ status: 'archived' })
      .expect(200);
    const updatedAudit = await prisma.auditLog.findFirst({
      where: { objectType: 'video_inspiration', objectId: id, action: 'video_inspiration.updated' },
    });
    expect(updatedAudit).not.toBeNull();
    expect(updatedAudit!.before as object).toMatchObject({ status: 'active' });
    expect(updatedAudit!.after as object).toMatchObject({ status: 'archived' });
  });
});
