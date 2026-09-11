import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import router from './router';
import { setupMessageUx } from './utils/message-ux';
import { initTheme } from './utils/theme';
import 'element-plus/theme-chalk/dark/css-vars.css'; // 深色模式 EP 变量（html.dark 生效）
import './style.css';
import './styles/apple.css'; // Apple 设计令牌（V2.0 全局基线）

initTheme(); // 主题先于渲染恢复，避免深色用户刷新闪白
setupMessageUx(); // 全局提示：带关闭按钮 + 点卡片即关（须在业务调用 ElMessage 前装好）

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');
