import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    globals: true,
    globalSetup: ['test/global-setup.ts'],
    // 每个测试文件导入前先落库指向：ConfigModule.forRoot 在 AppModule 导入时求值，
    // beforeAll 里再赋值 WG_DATABASE_URL 无效（详见 test/test-env-setup.ts 注释）
    setupFiles: ['test/test-env-setup.ts'],
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // 集成测试共享同一测试库，其中 ai-switch.spec 会真实切换全局 AI 开关（SystemMeta），
    // 并行执行会与其他套件的 submitTask/hello 调用产生竞态（撞上开关关闭窗口而 503）。
    // 串行执行文件以消除跨文件全局状态竞态（Task 7 引入，套件规模小，耗时可接受）。
    fileParallelism: false,
  },
});
