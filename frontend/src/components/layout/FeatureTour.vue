<script setup lang="ts">
/* global window, document, HTMLElement, localStorage, setInterval, clearInterval */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

/** 功能引导（2026-08-22 升级）：教练标注式——每步聚焦一个真实元素：
 * 遮罩挖孔高亮目标 + 旁边弹出带箭头的介绍卡（上一步/下一步/跳过）。
 * 看完写 localStorage('wg.tipsDone')；顶栏「?」可重看（AppLayout 控制 visible）。 */
const TIPS_KEY = 'wg.tipsDone';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>();

interface TourStep {
  selector: string;
  icon: string;
  title: string;
  body: string;
}

const STEPS: readonly TourStep[] = [
  {
    selector: '.global-search',
    icon: '🔍',
    title: '全店搜索',
    body: '任何页面按 ⌘K（Windows：Ctrl+K），客户、知识、施工单一搜即达；点知识条目直接看全文。',
  },
  {
    selector: '[data-test="notification-bell"]',
    icon: '🔔',
    title: '通知铃铛',
    body: '审批待办、排期确认都从这里提醒你，未读有角标；点条目直达处理。',
  },
  {
    selector: '[data-test="theme-toggle"]',
    icon: '🌗',
    title: '深色 / 浅色模式',
    body: '点这里切换整套界面配色，选择会记住，下次打开自动沿用。',
  },
  {
    selector: '[data-test="change-password-entry"]',
    icon: '🔧',
    title: '修改密码',
    body: '首次登录请及时改成自己的密码（齿轮按钮）；忘了找老板重置。',
  },
  {
    selector: '[data-test="tips-entry"]',
    icon: '❓',
    title: '功能小贴士',
    body: '这个「?」按钮随时重看本引导；以后新增功能也会在这里补充讲解。',
  },
  {
    selector: '.app-layout__aside',
    icon: '🗂',
    title: '功能菜单',
    body: '左侧按你的角色显示可用功能；老板、店长、销售看到的菜单各不相同。',
  },
];

const step = ref(0);
/** 当前步骤的目标元素及其几何信息（每步/滚动/缩放时重算） */
const targetRect = ref<{ x: number; y: number; h: number; w: number } | null>(null);
/** 卡片放置方位（依目标位置自动选择） */
const placement = ref<'right' | 'left' | 'bottom' | 'top'>('right');
/** 遮罩/卡片是否实际展示（visible 之外的第二道闸：有弹窗打开时挂起等待） */
const active = ref(false);
/** 挂起等待弹窗关闭的轮询句柄 */
let waitTimer: ReturnType<typeof setInterval> | null = null;

/** 2026-08-28 UI 测试 #7：预约对话框等弹窗打开时 tour 曾悬浮最上层（z-index 2500）
 * 遮挡表单、点击全部失效。判定规则：存在可见的 el-overlay（对话框/抽屉/消息框遮罩）
 * 即视为「有弹窗」，tour 挂起不展示，待其全部关闭再出现。 */
function hasBlockingOverlay(): boolean {
  return Boolean(
    document.querySelector('.el-overlay:not([style*="display: none"])') ??
    document.querySelector('.el-message-box:not([style*="display: none"])'),
  );
}

function stopWaiting(): void {
  if (waitTimer !== null) {
    clearInterval(waitTimer);
    waitTimer = null;
  }
}

function showIfFree(): void {
  if (hasBlockingOverlay()) {
    // 弹窗还开着：不抢占（overlay 打开期间 tour 出现即遮挡），轮询等关闭
    active.value = false;
    stopWaiting();
    waitTimer = setInterval(() => {
      if (!hasBlockingOverlay()) {
        stopWaiting();
        active.value = true;
        void locate();
      }
    }, 300);
    return;
  }
  active.value = true;
  void locate();
}

function findTarget(): HTMLElement | null {
  const s = STEPS[step.value];
  return document.querySelector<HTMLElement>(s.selector);
}

async function locate(): Promise<void> {
  await nextTick();
  const el = findTarget();
  if (!el) {
    targetRect.value = null;
    return;
  }
  const r = el.getBoundingClientRect();
  targetRect.value = { x: r.x, y: r.y, w: r.width, h: r.height };
  // 自动选方位：优先右侧空间大处
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (r.right + 340 < vw) placement.value = 'right';
  else if (r.left - 340 > 0) placement.value = 'left';
  else if (r.bottom + 220 < vh) placement.value = 'bottom';
  else placement.value = 'top';
}

function onResize(): void {
  void locate();
}

watch(
  () => props.visible,
  (v) => {
    stopWaiting();
    if (v) {
      step.value = 0;
      showIfFree(); // 有弹窗打开时挂起，关闭后再出现（不遮挡表单）
    } else {
      active.value = false;
    }
  },
  { immediate: true }, // 挂载即已可见（首登）也要定位，否则只有暗幕无卡片
);
watch(step, () => void locate());

function go(delta: number): void {
  const next = step.value + delta;
  // 目标元素不存在（角色/页面差异）时自动跳过该步
  if (next >= 0 && next < STEPS.length) {
    step.value = next;
    void nextTick(() => {
      if (!findTarget()) go(delta);
    });
  }
  if (next >= STEPS.length) finish();
}

function finish(): void {
  stopWaiting();
  localStorage.setItem(TIPS_KEY, '1');
  active.value = false;
  emit('update:visible', false);
}

const isLast = computed(() => step.value === STEPS.length - 1);

/** 卡片定位（模板不能引用 window，集中在 script 计算）。
 * 2026-08-22 修复越界：方位偏移全部数字化并入坐标（卡片宽 320、高约 230），
 * 并对四边做视口夹取——不依赖 class transform（曾被入场动画的 transform 覆盖导致溢出）。 */
const cardStyle = computed(() => {
  const t = targetRect.value;
  if (!t) return {};
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  const W = 320;
  const H = 230;
  let left: number;
  let top: number;
  if (placement.value === 'right') {
    left = t.x + t.w + 22;
    top = t.y + t.h / 2 - H / 2;
  } else if (placement.value === 'left') {
    left = t.x - 22 - W;
    top = t.y + t.h / 2 - H / 2;
  } else if (placement.value === 'bottom') {
    left = t.x + t.w / 2 - W / 2;
    top = t.y + t.h + 22;
  } else {
    left = t.x + t.w / 2 - W / 2;
    top = t.y - 22 - H;
  }
  left = Math.min(Math.max(left, 16), Math.max(16, vw - W - 16));
  top = Math.min(Math.max(top, 16), Math.max(16, vh - H - 16));
  return { left: `${left}px`, top: `${top}px` };
});

onMounted(() => window.addEventListener('resize', onResize));
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  stopWaiting();
});
</script>

<template>
  <!-- active（而非 visible）：有弹窗打开时挂起不渲染，杜绝遮挡表单（2026-08-28 UI 测试 #7） -->
  <div v-if="visible && active" class="tour" data-test="feature-tour">
    <!-- 聚焦遮罩：目标区域挖孔（巨量 box-shadow 实现圆角聚焦框） -->
    <div
      v-if="targetRect"
      class="tour__spot"
      :style="{
        left: `${targetRect.x - 6}px`,
        top: `${targetRect.y - 6}px`,
        width: `${targetRect.w + 12}px`,
        height: `${targetRect.h + 12}px`,
      }"
      aria-hidden="true"
    />
    <div v-else class="tour__dim" aria-hidden="true" />

    <!-- 介绍卡（带箭头指向目标） -->
    <div
      v-if="targetRect"
      class="tour__card"
      :class="`tour__card--${placement}`"
      :style="cardStyle"
      :data-test="`tour-card-${step}`"
    >
      <div class="tour__head">
        <span class="tour__icon">{{ STEPS[step].icon }}</span>
        <div>
          <p class="tour__kicker">{{ step + 1 }}/{{ STEPS.length }} · {{ STEPS[step].title }}</p>
        </div>
      </div>
      <p class="tour__body">{{ STEPS[step].body }}</p>
      <div class="tour__foot">
        <span class="tour__dots" aria-hidden="true">
          <i v-for="(_, i) in STEPS" :key="i" :class="{ 'is-on': i === step }" />
        </span>
        <div class="tour__btns">
          <button v-if="step > 0" class="tour__ghost" @click="go(-1)">上一步</button>
          <button class="tour__ghost" @click="finish">跳过</button>
          <button class="tour__next" data-test="tour-next" @click="go(1)">
            {{ isLast ? '开始使用' : '下一步' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tour {
  position: fixed;
  inset: 0;
  z-index: 2500;
}
.tour__spot {
  position: fixed;
  border-radius: 10px;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.52);
  pointer-events: none;
  transition:
    left 0.3s cubic-bezier(0.22, 1, 0.36, 1),
    top 0.3s cubic-bezier(0.22, 1, 0.36, 1),
    width 0.3s cubic-bezier(0.22, 1, 0.36, 1),
    height 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}
.tour__dim {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.52);
}
.tour__card {
  position: fixed;
  width: 320px;
  max-width: calc(100vw - 24px); /* 手机（2026-09-02）：目标在屏幕边缘时不溢出右缘 */
  padding: 18px 18px 14px;
  background: var(--wg-surface);
  color: var(--wg-ink);
  border: 1px solid var(--wg-hairline);
  border-radius: 16px;
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.28);
  animation: tour-in 0.28s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes tour-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
/* 箭头：依方位指向目标 */
.tour__card--right::before,
.tour__card--left::before,
.tour__card--bottom::before,
.tour__card--top::before {
  content: '';
  position: absolute;
  width: 14px;
  height: 14px;
  background: var(--wg-surface);
  border: 1px solid var(--wg-hairline);
  transform: rotate(45deg);
}
.tour__card--right::before {
  left: -8px;
  top: 50%;
  margin-top: -7px;
  border-right: none;
  border-bottom: none;
}
.tour__card--left::before {
  right: -8px;
  top: 50%;
  margin-top: -7px;
  border-left: none;
  border-top: none;
}
.tour__card--bottom::before {
  left: 50%;
  margin-left: -7px;
  top: -8px;
  border-right: none;
  border-top: none;
}
.tour__card--top::before {
  left: 50%;
  margin-left: -7px;
  bottom: -8px;
  border-left: none;
  border-bottom: none;
}
.tour__head {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 10px;
}
.tour__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  font-size: 20px;
  background: var(--wg-canvas);
  border-radius: 12px;
}
.tour__kicker {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.tour__body {
  margin: 0 0 14px;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--wg-ink-muted);
}
.tour__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.tour__dots {
  display: flex;
  gap: 5px;
}
.tour__dots i {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: var(--wg-hairline);
}
.tour__dots i.is-on {
  background: var(--wg-primary);
}
.tour__btns {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tour__ghost {
  border: none;
  background: none;
  font-size: 12px;
  color: var(--wg-ink-muted);
  cursor: pointer;
}
.tour__ghost:hover {
  color: var(--wg-ink);
}
.tour__next {
  border: none;
  border-radius: 9999px;
  padding: 7px 16px;
  background: var(--wg-primary);
  color: #fff;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.2s ease;
}
.tour__next:hover {
  opacity: 0.88;
}
</style>
