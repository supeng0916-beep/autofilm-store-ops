import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { maskDeep, maskName, scanForLeaks } from '../src/modules/ai-dispatch/masker';
import { CustomerRefService } from '../src/modules/ai-dispatch/customer-ref.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';

describe('masker（P2-02 脱敏器）', () => {
  it('键名驱动：phone/wechat/plate/address/name 全部替换为占位符', () => {
    const out = maskDeep({
      phone: '13800138000',
      wechat: 'wx_secret_id',
      plateNo: '粤E·12345',
      address: '某市禅城区某小区1栋',
      name: '张三',
    }) as Record<string, string>;
    expect(out.phone).toBe('[PHONE]');
    expect(out.wechat).toBe('[WECHAT]');
    expect(out.plateNo).toBe('[PLATE]');
    expect(out.address).toBe('[ADDRESS]');
    expect(out.name).toBe('张客户');
  });

  it('正则兜底：自由文本中的手机号与车牌被抹除', () => {
    const out = maskDeep({
      note: '客户电话13800138000，车牌粤E12345，意向强',
    }) as Record<string, string>;
    expect(out.note).toBe('客户电话[PHONE]，车牌[PLATE]，意向强');
  });

  it('自由文本微信号启发式打码：wxid 前缀与「微信号」标签，不误伤普通文本', () => {
    const text = '客户想贴改色膜，新微信 wxid-xyz，微信号 abcde12345，车型凯迪拉克XT5，预算9200';
    const out = maskDeep({ rawNeed: text }) as Record<string, string>;
    expect(out.rawNeed).not.toContain('wxid-xyz');
    expect(out.rawNeed).not.toContain('abcde12345');
    expect(out.rawNeed).toContain('[WECHAT]');
    expect(out.rawNeed).toContain('凯迪拉克XT5');
    expect(out.rawNeed).toContain('9200');
    expect(scanForLeaks(out)).toHaveLength(0);
    expect(scanForLeaks({ rawNeed: text }).length).toBeGreaterThan(0);
  });

  it('多号码混合文本全部命中', () => {
    const out = maskDeep({ note: '13800138000 与 15924680278 都打过' }) as Record<string, string>;
    expect(out.note).not.toMatch(/1[3-9]\d{9}/);
  });

  it('嵌套与数组递归脱敏', () => {
    const out = maskDeep({ list: [{ mobile: '13800138000' }, { note: 'ok' }] }) as {
      list: { mobile?: string; note?: string }[];
    };
    expect(out.list[0].mobile).toBe('[PHONE]');
    expect(out.list[1].note).toBe('ok');
  });

  it('金额与业务字段保留（规格 §5.4：金额保留供经营判断）', () => {
    const out = maskDeep({ price: 9200, carModel: 'Model Y' }) as Record<string, unknown>;
    expect(out.price).toBe(9200);
    expect(out.carModel).toBe('Model Y');
  });

  it('maskName 按性别生成先生/女士', () => {
    expect(maskName('张三', 'male')).toBe('张先生');
    expect(maskName('李四', 'female')).toBe('李女士');
    expect(maskName('王五')).toBe('王客户');
  });

  it('scanForLeaks 命中原始载荷、放行脱敏后载荷', () => {
    const raw = { phone: '13800138000', note: '车牌粤E12345' };
    expect(scanForLeaks(raw).length).toBeGreaterThan(0);
    expect(scanForLeaks(maskDeep(raw))).toHaveLength(0);
  });

  it('回归：全字段载荷脱敏后 scanForLeaks 为空（含 name 的 maskName 形态，防 Task 5 降级误报）', () => {
    const masked = maskDeep({ name: '张三', phone: '13800138000', wechat: 'wx_id' });
    expect(scanForLeaks(masked)).toHaveLength(0);
  });

  it('回归：未脱敏 name 键仍被 scanForLeaks 命中', () => {
    expect(scanForLeaks({ name: '张三' })).toEqual([{ path: '$.name', type: 'name' }]);
  });

  it('R1：数字型手机号不再穿透——脱敏为占位符，scanForLeaks 前后 1 hit / 0 hits', () => {
    const raw = { phone: 13800138000 };
    expect(scanForLeaks(raw)).toEqual([{ path: '$.phone', type: 'phone' }]);
    const out = maskDeep(raw) as Record<string, string>;
    expect(out.phone).toBe('[PHONE]');
    expect(scanForLeaks(out)).toHaveLength(0);
  });

  it('R1：数字型车牌同理', () => {
    const raw = { plate: 12345 };
    expect(scanForLeaks(raw)).toEqual([{ path: '$.plate', type: 'plate' }]);
    const out = maskDeep(raw) as Record<string, string>;
    expect(out.plate).toBe('[PLATE]');
    expect(scanForLeaks(out)).toHaveLength(0);
  });

  it('R1：先生/女士/客户 后缀豁免仅限 name 键——wechat 值「某某客户」仍命中', () => {
    expect(scanForLeaks({ wechat: '某某客户' })).toEqual([{ path: '$.wechat', type: 'wechat' }]);
  });
});

describe('CustomerRefService 假名 ID 映射（P2-02 / A04）', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let refs: CustomerRefService;
  let customerId: string;

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    refs = app.get(CustomerRefService);
    // 合成数据（S16：测试禁真实客户数据）
    const customer = await prisma.customer.create({
      data: { name: '测试甲', phone: '13800138000' },
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    await prisma.customerRefId.deleteMany({ where: { customerId } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await app.close();
  });

  it('首次调用创建 ref_ 前缀假名 ID', async () => {
    const refId = await refs.getOrCreate(customerId);
    expect(refId).toMatch(/^ref_/);
  });

  it('getOrCreate 幂等：重复调用返回同一 ID，映射仅一行', async () => {
    const first = await refs.getOrCreate(customerId);
    const second = await refs.getOrCreate(customerId);
    expect(second).toBe(first);
    const count = await prisma.customerRefId.count({ where: { customerId } });
    expect(count).toBe(1);
  });

  it('并发 getOrCreate（Promise.all ×8）：新建客户仅产生一条 refId（P2 终审 triage）', async () => {
    // 用全新客户强制 8 个并发调用都走「无映射」创建路径，真实并发断言（不 mock）
    const fresh = await prisma.customer.create({
      data: { name: '并发甲', phone: '13900139000' },
    });
    try {
      const ids = await Promise.all(Array.from({ length: 8 }, () => refs.getOrCreate(fresh.id)));
      expect(new Set(ids).size).toBe(1);
      expect(await prisma.customerRefId.count({ where: { customerId: fresh.id } })).toBe(1);
    } finally {
      await prisma.customerRefId.deleteMany({ where: { customerId: fresh.id } });
      await prisma.customer.deleteMany({ where: { id: fresh.id } });
    }
  });
});

/** R2-05（2026-09-09 二轮复验实锤）：storeName 命中 *name 人名规则被打成「佛客户」——
 * GEO 诊断对象无法确认，verdict 只能靠模型猜。门店/品牌/机构等公开实体名不是客户
 * 隐私，豁免人名打码；内容正则兜底照跑（实体名里的电话/车牌仍打码）。人名键
 * （name/customerName/technicianName）脱敏行为保持不变。 */
describe('实体名键豁免人名打码（R2-05）', () => {
  it('storeName/brandName/companyName 原样保留（公开经营信息非隐私）', () => {
    const out = maskDeep({
      storeName: 'AutoFilm Demo',
      brandName: '演示品牌 DEMO BRAND',
      companyName: 'AutoFilm Demo汽车服务有限公司',
      platformName: '大众点评',
    }) as Record<string, string>;
    expect(out.storeName).toBe('AutoFilm Demo');
    expect(out.brandName).toBe('演示品牌 DEMO BRAND');
    expect(out.companyName).toBe('AutoFilm Demo汽车服务有限公司');
    expect(out.platformName).toBe('大众点评');
  });
  it('实体名键内容兜底照跑：夹带电话仍打码', () => {
    const out = maskDeep({ storeName: '本地店13800138000' }) as Record<string, string>;
    expect(out.storeName).toBe('本地店[PHONE]');
  });
  it('回归：人名键照旧打码（name/customerName/technicianName）', () => {
    const out = maskDeep({
      name: '王五',
      customerName: '张三',
      technicianName: '李师傅',
    }) as Record<string, string>;
    expect(out.name).toBe('王客户');
    expect(out.customerName).toBe('张客户');
    expect(out.technicianName).toBe('李客户');
  });
  it('scanForLeaks 同口径：storeName 不再按 name 泄漏命中（拒发闸门不误伤）', () => {
    expect(scanForLeaks({ storeName: 'AutoFilm Demo' })).toEqual([]);
    expect(scanForLeaks({ customerName: '张三' })).toEqual([
      { path: '$.customerName', type: 'name' },
    ]);
  });
});
