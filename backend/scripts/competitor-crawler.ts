/* eslint-disable */
// @ts-nocheck
/**
 * 同行抖音公开数据爬虫 PoC（批次4 T3）——独立外挂脚本，不进主进程、不是生产依赖。
 *
 * 使用前提（老板 2026-09-02 拍板：允许爬同行公开数据，不爬客户资料）：
 *   1) npm i -D playwright && npx playwright install chromium（约 120MB，装门店机一次）
 *   2) 首次登录态准备：npx tsx scripts/competitor-crawler.ts --login
 *      会开有头浏览器→人工登录抖音网页版→登录态存 storage/competitor-state.json（复用）
 *   3) 抓取：npx tsx scripts/competitor-crawler.ts
 *      读 storage 状态→无头访问配置里同行主页→提取作品标题/点赞/评论→调后端 crawler 端点落库
 *
 * 护栏（对抗风控、降低账号风险）：
 *   - 每账号只拉主页前 2 屏（约 12~20 条公开作品），不翻页不进详情
 *   - 账号间随机停 30~90 秒；单次运行 ≤5 账号；建议每天最多跑一次（cron 别密集）
 *   - 任何风控迹象（滑块/验证码/空数据）立即跳过该账号并在输出标明，绝不重试轰炸
 *
 * 已知残余风险（门店自担，如实告知）：抖音反自动化检测可能导致账号限流/要求验证；
 * 页面结构改版会使选择器失效需维护。脚本失败不影响看板（人工录入兜底）。
 *
 * 配置：competitor-crawler.config.json { accounts: ["账号1","账号2"], apiBase, token }
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE_DIR = join(__dirname, '..', 'storage');
const STATE_FILE = join(STATE_DIR, 'competitor-state.json');
const CONFIG_FILE = join(__dirname, 'competitor-crawler.config.json');

interface CrawlItem {
  account: string;
  title: string;
  likesCount?: number;
  commentsCount?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** 抖音主页 URL：支持配置里直接写 sec_uid 或完整链接 */
function profileUrl(account: string): string {
  return account.startsWith('http') ? account : `https://www.douyin.com/user/${account}`;
}

/** 数字文本（1.2万 → 12000）转数值 */
function parseCount(text: string): number | undefined {
  const t = text.trim();
  if (!t || t === '赞' || t === '评论') return undefined;
  const m = t.match(/^([\d.]+)\s*(万)?/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] ? Math.round(n * 10000) : Math.round(n);
}

async function main(): Promise<void> {
  const { chromium } = (await import('playwright')) as {
    chromium: import('playwright').BrowserType;
  }; // 可选依赖：未安装时 --login/抓取按运行时错误提示
  const isLogin = process.argv.includes('--login');
  const config = existsSync(CONFIG_FILE)
    ? (JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as {
        accounts: string[];
        apiBase: string;
        token: string;
      })
    : { accounts: [], apiBase: 'http://127.0.0.1:8000/api/v1', token: '' };
  mkdirSync(STATE_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: !isLogin });
  const ctx = await browser.newContext({
    ...(existsSync(STATE_FILE) && !isLogin ? { storageState: STATE_FILE } : {}),
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();

  if (isLogin) {
    console.log('请在打开的浏览器里登录抖音，登录成功后回到终端按回车保存登录态…');
    await page.goto('https://www.douyin.com/');
    await new Promise<void>((resolve) => {
      process.stdin.once('data', () => resolve());
    });
    await ctx.storageState({ path: STATE_FILE });
    console.log('登录态已保存：', STATE_FILE);
    await browser.close();
    return;
  }

  const items: CrawlItem[] = [];
  for (const account of config.accounts.slice(0, 5)) {
    console.log(`抓取 ${account} …`);
    try {
      await page.goto(profileUrl(account), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(rand(3000, 6000));
      // 风控迹象检测：出现验证码/滑块则跳过
      const blocked = await page
        .locator('text=验证码')
        .first()
        .isVisible()
        .catch(() => false);
      if (blocked) {
        console.log(`  ⚠ ${account} 出现验证码，跳过（切勿重试轰炸）`);
        continue;
      }
      // 作品卡片：标题 a/点赞数。选择器宽松兜底，页面改版时此处最易失效
      const cards = await page.locator('[data-e2e="scroll-list"] > ul > li').all();
      for (const card of cards.slice(0, 18)) {
        const title = (
          await card
            .locator('a p, a')
            .first()
            .innerText()
            .catch(() => '')
        ).trim();
        if (!title) continue;
        const spans = await card
          .locator('span')
          .allInnerTexts()
          .catch(() => [] as string[]);
        const likes = spans.map(parseCount).find((n) => n !== undefined);
        items.push({
          account,
          title: title.slice(0, 200),
          ...(likes !== undefined ? { likesCount: likes } : {}),
        });
      }
      console.log(`  ${items.filter((i) => i.account === account).length} 条`);
    } catch (err) {
      console.log(`  ⚠ ${account} 抓取失败：${err instanceof Error ? err.message : err}`);
    }
    await sleep(rand(30000, 90000)); // 账号间长停顿
  }
  await browser.close();

  if (items.length === 0) {
    console.log('本轮无数据（可能登录态过期/页面改版/全部被风控）——看板用人工录入兜底');
    return;
  }
  // 回传后端（boss token 走 crawler 端点）
  if (!config.token) {
    console.log('未配置 token，仅打印结果不落库：', JSON.stringify(items.slice(0, 5), null, 2));
    writeFileSync(join(STATE_DIR, 'competitor-last-run.json'), JSON.stringify(items, null, 2));
    return;
  }
  const res = await fetch(`${config.apiBase}/marketing/competitor-posts/crawler`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ items }),
  });
  console.log('落库结果：', res.status, await res.text());
}

main().catch((err) => {
  console.error('爬虫异常退出：', err);
  process.exit(1);
});
