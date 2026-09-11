import { PrismaService } from '../src/prisma/prisma.service';
import { buildApp } from './setup';

describe('PrismaService（P0-04：全局注入 + 惰性连接）', () => {
  beforeAll(() => {
    // 指向不可达端口：仍能装配启动即证明惰性连接（P0 测试不依赖活库）
    process.env.WG_DATABASE_URL = 'postgresql://autofilm:autofilm@localhost:59999/nope';
  });

  it('随 AppModule 全局可注入，具备 PrismaClient 能力', async () => {
    const app = await buildApp();
    const svc = app.get(PrismaService);
    // Prisma 7 客户端实例为 Proxy 且原型链被改写，instanceof 恒为 false，
    // 且 vitest toBeInstanceOf 的失败信息格式化会对其栈溢出——故用构造名+鸭子类型断言
    expect(svc.constructor.name).toBe('PrismaService');
    expect(typeof svc.$queryRawUnsafe).toBe('function');
    expect(typeof svc.$disconnect).toBe('function');
    expect(svc.systemMeta).toBeDefined();
    await app.close();
  });

  it('启动时不强制连库（库不可达也能 init）', async () => {
    const app = await buildApp();
    expect(app.get(PrismaService)).toBeDefined();
    await app.close();
  });
});
