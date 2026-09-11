import { ElMessage, type MessageHandler } from 'element-plus';

type MsgFn = (options: never) => MessageHandler;
type AnyMsgFn = (options: unknown) => MessageHandler;

/** 居中基线：提示从视口垂直中心起、向下堆叠（EP 自身会按前序高度累加，
 * 2026-08-27 弹窗统一：与退出登录等 ElMessageBox 同一视觉层级——居中卡片，
 * 不再是顶部飘过的小条（门店反馈「看起来像 bug」）。 */
function centeredOffset(): number {
  const vh = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 768;
  return Math.max(16, Math.round(vh / 2 - 28));
}

/** 同文案去重：同一（类型+文案）提示仍在屏上时不再重复弹出——
 * 轮询/重试等并发失败不再叠出一排同样的卡片。 */
const visible = new Map<string, MessageHandler>();

const withUx =
  (type: string, orig: AnyMsgFn): AnyMsgFn =>
  (options: unknown) => {
    const opts: Record<string, unknown> =
      typeof options === 'string' ? { message: options } : { ...(options as object) };
    const key = `${type}:${String(opts.message ?? '')}`;
    if (visible.has(key)) return visible.get(key) as MessageHandler;
    const userOnClose =
      typeof opts.onClose === 'function' ? (opts.onClose as () => void) : undefined;
    opts.onClose = () => {
      visible.delete(key);
      userOnClose?.();
    };
    opts.showClose = true;
    opts.customClass = ['wg-message', opts.customClass].filter(Boolean).join(' ');
    if (typeof opts.offset !== 'number') opts.offset = centeredOffset();
    const handler = orig(opts);
    visible.set(key, handler);
    return handler;
  };

/** 全局提示 UX：
 * ① 所有 ElMessage 统一为居中卡片形态（wg-message 样式 + 垂直居中 offset）；
 * ② 自动带关闭按钮、点击提示卡片任意位置即可关闭（复用 EP 自身关闭逻辑）；
 * ③ 同一（类型+文案）在屏期间去重，不重复弹出。
 * 在 main.ts 挂载前调用一次；幂等（重复调用不重复注册）。 */
let installed = false;
/** 转发去抖：同一 click 传播风暴只转发一次（happy-dom 会多次送达，浏览器单次亦不受影响） */
let lastForwardAt = 0;

export function setupMessageUx(): void {
  if (installed) return;
  installed = true;
  for (const type of ['success', 'warning', 'info', 'error'] as const) {
    const orig = (ElMessage[type] as unknown as MsgFn).bind(ElMessage);
    (ElMessage as unknown as Record<string, unknown>)[type] = withUx(
      type,
      orig as unknown as AnyMsgFn,
    );
  }
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const card = target.closest?.('.el-message');
    if (!card) return;
    const btn = card.querySelector<HTMLElement>('.el-message__closeBtn');
    // 点 X 本身会冒泡到 document，这里只转发「点卡片其他区域」；转发用非冒泡事件
    //（EP 的关闭监听就挂在按钮自身），并按时间戳去抖防同风暴重复转发
    const now = Date.now();
    if (btn && !target.closest('.el-message__closeBtn') && now - lastForwardAt > 50) {
      lastForwardAt = now;
      btn.dispatchEvent(new MouseEvent('click'));
    }
  });
}

/** 测试用：清空在屏去重表并允许重新安装（生产代码勿用） */
export function __resetMessageUxForTest(): void {
  visible.clear();
  installed = false;
}
