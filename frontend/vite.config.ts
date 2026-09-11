/// <reference types="vitest/config" />
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { defineConfig } from 'vite';

// 开发代理：/api 转发到后端 :8000，前端 baseURL 保持 /api/v1
export default defineConfig({
  plugins: [
    vue(),
    // dts 生成到 src/ 内：纳入 tsconfig include，保证 CI 全新环境 typecheck 可用
    AutoImport({ resolvers: [ElementPlusResolver()], dts: 'src/auto-imports.d.ts' }),
    Components({ resolvers: [ElementPlusResolver()], dts: 'src/components.d.ts' }),
  ],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['src/test-setup.ts'],
    // 按需引入后 resolver 会注入 element-plus 的 style/css 入口（含 .css 导入），
    // 必须 inline 让 vite 管道处理，否则 Node 原生 ESM 报 Unknown file extension ".css"
    server: { deps: { inline: ['element-plus'] } },
  },
});
