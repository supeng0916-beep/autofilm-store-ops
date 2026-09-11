/** 主题（深/浅色）管理：偏好持久化 localStorage('wg.theme')，默认浅色。
 * 2026-08-21 首轮部署品牌化：顶栏日月切换；html.dark 驱动 apple.css 深色变量与 EP dark。 */
const THEME_KEY = 'wg.theme';
export type Theme = 'light' | 'dark';

export function getStoredTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  localStorage.setItem(THEME_KEY, theme);
}

/** main.ts 最早调用：避免刷新时主题闪烁 */
export function initTheme(): Theme {
  const t = getStoredTheme();
  document.documentElement.classList.toggle('dark', t === 'dark');
  return t;
}
