<script setup lang="ts">
/* global window, requestAnimationFrame, cancelAnimationFrame, clearTimeout, matchMedia, HTMLElement, HTMLCanvasElement, CanvasRenderingContext2D */
import { ElMessageBox } from 'element-plus';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import companyLogo from '../assets/company-logo.svg';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

/* ───────── 第一页：深色金属粒子入口 ─────────
 * 保留中文主标题与品牌 V 标记，金色粒子只做背景层，不干扰阅读。 */
const phase = ref<'landing' | 'form'>('landing');

const particlesEl = ref<HTMLCanvasElement | null>(null);
let particleRaf = 0;
let particleCtx: CanvasRenderingContext2D | null = null;
let particleWidth = 0;
let particleHeight = 0;
const particles: Array<{
  x: number;
  y: number;
  size: number;
  speed: number;
  drift: number;
  alpha: number;
  color: string;
  glow: boolean;
  twinkle: boolean;
  twinkleSpeed: number;
}> = [];

function resizeParticles(): void {
  const canvas = particlesEl.value;
  if (!canvas) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  particleWidth = window.innerWidth;
  particleHeight = window.innerHeight;
  canvas.width = particleWidth * ratio;
  canvas.height = particleHeight * ratio;
  canvas.style.width = `${particleWidth}px`;
  canvas.style.height = `${particleHeight}px`;
  particleCtx = canvas.getContext('2d');
  particleCtx?.setTransform(ratio, 0, 0, ratio, 0, 0);
  particles.length = 0;
  // 约 200 个粒子，按屏幕面积自适应；小屏保留足够密度，大屏避免过载。
  const count = Math.min(220, Math.max(80, Math.floor((particleWidth * particleHeight) / 6500)));
  const palette = ['#BF953F', '#FCF6BA', '#B38728', '#AA771C', '#FFD700', '#E5C580'];
  for (let i = 0; i < count; i += 1) {
    particles.push({
      x: Math.random() * particleWidth,
      y: Math.random() * particleHeight,
      size: Math.random() * 1.9 + 0.55,
      speed: Math.random() * 0.6 + 0.2,
      drift: (Math.random() - 0.5) * 0.16,
      alpha: Math.random() * 0.6 + 0.3,
      color: palette[Math.floor(Math.random() * palette.length)],
      glow: Math.random() < 0.15,
      twinkle: Math.random() < 0.3,
      twinkleSpeed: Math.random() * 0.025 + 0.01,
    });
  }
}

function animateParticles(): void {
  if (!particleCtx) return;
  // 半透明黑色覆盖保留上一帧残影，制造自然拖尾。
  particleCtx.fillStyle = 'rgba(0, 0, 0, 0.15)';
  particleCtx.fillRect(0, 0, particleWidth, particleHeight);
  for (const particle of particles) {
    particle.y += particle.speed;
    particle.x += particle.drift;
    if (particle.y > particleHeight + 8) particle.y = -8;
    if (particle.x < -8) particle.x = particleWidth + 8;
    if (particle.x > particleWidth + 8) particle.x = -8;
    if (particle.twinkle) {
      particle.alpha += particle.twinkleSpeed;
      if (particle.alpha > 0.95 || particle.alpha < 0.2) particle.twinkleSpeed *= -1;
    }
    particleCtx.globalAlpha = particle.alpha;
    particleCtx.fillStyle = particle.color;
    particleCtx.shadowBlur = particle.glow ? 10 : 0;
    particleCtx.shadowColor = particle.color;
    particleCtx.beginPath();
    particleCtx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
    particleCtx.fill();
    particleCtx.shadowBlur = 0;
  }
  particleCtx.globalAlpha = 1;
  particleRaf = requestAnimationFrame(animateParticles);
}

/* ───────── 黑圆扩张转场：以「进入工作台」按钮为原点铺满视口 → 切换登录页 ───────── */
const expanding = ref(false);
const coverOpen = ref(false);
const coverStyle = ref<Record<string, string>>({});
const pillRef = ref<HTMLElement | null>(null);
let coverTimer: number | undefined;
let fadeTimer: number | undefined;

function goLoginForm(): void {
  if (expanding.value) return;
  // 转场即停粒子（审查 #6）：切到表单页后 landing canvas 被 v-if 移除，
  // rAF 若不取消会拿着脱离文档的 ctx 空转整个输密码期间；resize 监听一并撤下
  cancelAnimationFrame(particleRaf);
  window.removeEventListener('resize', resizeParticles);
  particleCtx = null;
  const pill = pillRef.value;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cx = pill ? pill.getBoundingClientRect().left + pill.offsetWidth / 2 : vw / 2;
  const cy = pill ? pill.getBoundingClientRect().top + pill.offsetHeight / 2 : vh / 2;
  const radius = Math.ceil(
    Math.max(
      Math.hypot(cx, cy),
      Math.hypot(vw - cx, cy),
      Math.hypot(cx, vh - cy),
      Math.hypot(vw - cx, vh - cy),
    ) / 0.9,
  );
  coverStyle.value = {
    left: `${cx - radius}px`,
    top: `${cy - radius}px`,
    width: `${radius * 2}px`,
    height: `${radius * 2}px`,
  };
  expanding.value = true;
  coverOpen.value = false;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      coverOpen.value = true;
    });
  });
  coverTimer = window.setTimeout(() => {
    phase.value = 'form';
    fadeTimer = window.setTimeout(() => {
      expanding.value = false;
    }, 360);
  }, 660);
}

/* ───────── 第二页：登录表单（白底） ───────── */
const username = ref('');
const password = ref('');
const loading = ref(false);
const errorMsg = ref('');

interface LoginErrorBody {
  code?: string;
  message?: string;
  detail?: { remainingAttempts?: number } | null;
}

function toLoginMessage(body: LoginErrorBody | undefined, status?: number): string {
  if (body?.code === 'AUTH_INVALID_CREDENTIALS') {
    const left = body.detail?.remainingAttempts;
    return left !== undefined && left > 0
      ? `用户名或密码错误，还可尝试 ${left} 次（连续 5 次失败将锁定 15 分钟）`
      : '用户名或密码错误';
  }
  if (body?.code === 'AUTH_ACCOUNT_LOCKED') {
    return body.message ?? '账号已锁定，请 15 分钟后再试';
  }
  if (body?.code === 'AUTH_ACCOUNT_DISABLED') return '账号已停用，请联系管理员';
  return body?.message ?? `登录失败（${status ?? '网络异常'}），请重试`;
}

async function onSubmit(): Promise<void> {
  if (loading.value || !username.value || !password.value) return;
  loading.value = true;
  errorMsg.value = '';
  try {
    await auth.login(username.value, password.value);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await router.push({ path: '/welcome', query: redirect !== '/' ? { redirect } : undefined });
  } catch (err) {
    const resp = (err as { response?: { status?: number; data?: LoginErrorBody } }).response;
    errorMsg.value = toLoginMessage(resp?.data, resp?.status);
    // 密码错误弹窗（2026-08-22 门店反馈）：与退出确认同款极简居中卡片——
    // 无标题/图标，单句 + 关闭/重试；ElMessageBox 队列化，不叠 toast
    ElMessageBox.alert(errorMsg.value, '', {
      confirmButtonText: '重试',
      showClose: true,
      distinguishCancelAndClose: true,
    }).catch(() => undefined);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduced) {
    resizeParticles();
    particleRaf = requestAnimationFrame(animateParticles);
    window.addEventListener('resize', resizeParticles);
  }
});

onBeforeUnmount(() => {
  cancelAnimationFrame(particleRaf);
  window.removeEventListener('resize', resizeParticles);
  if (coverTimer) clearTimeout(coverTimer);
  if (fadeTimer) clearTimeout(fadeTimer);
});

const coverClass = computed(() => ({
  'login-cover--open': coverOpen.value,
  'login-cover--fade': phase.value === 'form',
}));
</script>

<template>
  <div class="login-root">
    <!-- ═══════════ 第一页：深色金属粒子入口 ═══════════ -->
    <section v-if="phase === 'landing'" class="landing">
      <div class="landing__brandline" aria-hidden="true">
        <span>AI</span><i /><b>AutoFilm Ops · AI经营协同系统</b>
      </div>
      <span class="landing__v-mark" aria-hidden="true">A</span>
      <canvas ref="particlesEl" class="landing__particles" aria-hidden="true" />

      <!-- 主标题：参考 DEMO BRAND hero 的单层金属渐变标题 -->
      <div class="landing__title-wrap">
        <h1 class="landing__title" aria-label="让门店协作，清晰、有序、可追溯。">
          让门店协作，<br />清晰、有序、可追溯。
        </h1>
      </div>

      <!-- 辅助说明：保持居中、低对比，避免抢过主标题 -->
      <p class="landing__sub">全栈作品集 · 业务流程协同 · AI 辅助决策</p>
      <p class="landing__product">AutoFilm Ops · AI经营协同系统</p>

      <!-- 进入工作台：金属高光按钮 -->
      <button ref="pillRef" class="landing__pill" data-test="goto-login" @click="goLoginForm">
        进入工作台
      </button>
    </section>

    <!-- ═══════════ 第二页：深色金属登录表单 ═══════════ -->
    <section v-else class="formpage">
      <p class="formpage__store">AutoFilm Demo</p>
      <span class="formpage__v-mark" aria-hidden="true">A</span>
      <div class="formpage__inner">
        <div class="formpage__card">
          <div class="formpage__field">
            <el-input
              v-model="username"
              placeholder="用户名"
              size="large"
              :disabled="loading"
              data-test="login-username"
              @keyup.enter="onSubmit"
            />
          </div>
          <div class="formpage__field">
            <el-input
              v-model="password"
              placeholder="密码"
              type="password"
              size="large"
              show-password
              :disabled="loading"
              data-test="login-password"
              @keyup.enter="onSubmit"
            />
          </div>
          <el-button
            :loading="loading"
            class="formpage__submit"
            data-test="login-submit"
            @click="onSubmit"
          >
            {{ loading ? '正在进入…' : '登 录' }}
          </el-button>
        </div>
      </div>

      <footer class="formpage__footer">
        <img class="formpage__logo" :src="companyLogo" alt="公司标识" />
        <p class="formpage__foot-text">
          探索前沿智能转化为社会价值的最优解 · 门店助手 · v0.1首轮试运行
        </p>
      </footer>
    </section>

    <!-- 黑圆扩张转场遮罩（以按钮为原点 scale 铺满视口） -->
    <div
      v-if="expanding"
      class="login-cover"
      :class="coverClass"
      :style="coverStyle"
      aria-hidden="true"
    />
  </div>
</template>

<style scoped>
/* ═══════════ 第一页：深色金属粒子入口 ═══════════ */
.landing {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--brand-void);
  color: var(--brand-ivory);
  overflow: hidden;
  isolation: isolate;
}
.landing__brandline {
  position: absolute;
  top: 30px;
  left: 34px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 10px;
  color: color-mix(in srgb, var(--brand-ivory) 68%, transparent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.18em;
}
.landing__brandline span {
  color: var(--brand-gold-bright);
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 17px;
  letter-spacing: 0.04em;
}
.landing__brandline i {
  width: 26px;
  height: 1px;
  background: var(--brand-gold-bright);
}
.landing__brandline b {
  font-weight: 600;
}
.landing__particles {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  opacity: 1;
  pointer-events: none;
}
.landing__v-mark {
  position: absolute;
  /* Canvas 会持续绘制黑色拖尾；V 必须位于粒子层之上才能保持可见。 */
  z-index: 1;
  top: 50%;
  left: 50%;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: min(64vw, 820px);
  font-weight: 400;
  line-height: 0.7;
  color: transparent;
  background: linear-gradient(
    120deg,
    #aa771c 0%,
    #fcf6ba 25%,
    #bf953f 50%,
    #fcf6ba 75%,
    #aa771c 100%
  );
  background-size: 240% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-stroke: 1px rgba(191, 149, 63, 0.58);
  filter: drop-shadow(0 0 22px rgba(191, 149, 63, 0.26));
  opacity: 0.28;
  animation: landing-v-shine 8s ease-in-out infinite;
  transform: translate3d(calc(-50% + var(--mx, 0) * -24px), calc(-50% + var(--my, 0) * -18px), 0);
  user-select: none;
  pointer-events: none;
}
@keyframes landing-v-shine {
  0%,
  100% {
    background-position: 0% 50%;
  }
  50% {
    background-position: 100% 50%;
  }
}
/* 主标题容器 */
.landing__title-wrap {
  position: relative;
  z-index: 2;
  width: min(1180px, calc(100vw - 64px));
  text-align: center;
}
.landing__title {
  margin: 0;
  font-family:
    -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue',
    sans-serif;
  font-size: clamp(42px, 6.8vw, 96px);
  font-weight: 800;
  line-height: 1.05;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
/* 单层金属渐变标题，避免多层文字叠加 */
.landing__title {
  position: relative;
  z-index: 1;
  color: transparent;
  background: linear-gradient(
    120deg,
    #aa771c 0%,
    #fcf6ba 25%,
    #bf953f 50%,
    #fcf6ba 75%,
    #aa771c 100%
  );
  background-size: 300% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  filter: drop-shadow(0 0 24px rgba(191, 149, 63, 0.28));
  animation: landing-gold-shine 4.8s ease-in-out infinite;
}
@keyframes landing-gold-shine {
  0%,
  100% {
    background-position: 0% 50%;
  }
  50% {
    background-position: 100% 50%;
  }
}
/* 副标语/产品名：白色隐形，黑球划过显现 */
.landing__sub {
  position: relative;
  z-index: 2;
  width: min(1180px, calc(100vw - 64px));
  margin: 34px 0 0;
  font-size: clamp(12px, 1.15vw, 17px);
  font-weight: 500;
  letter-spacing: 0.08em;
  color: color-mix(in srgb, var(--brand-ivory) 78%, transparent);
  text-align: center;
}
.landing__product {
  position: relative;
  z-index: 2;
  width: min(1180px, calc(100vw - 64px));
  margin: 12px 0 0;
  font-size: clamp(14px, 1.35vw, 20px);
  font-weight: 700;
  letter-spacing: 0.12em;
  color: #fcf6ba;
  text-align: center;
}
/* 进入工作台：白字白描边毛玻璃，黑球划过显现；hover 轻微放大 */
.landing__pill {
  position: relative;
  z-index: 2;
  align-self: center;
  margin-top: 7vh;
  margin-left: 0;
  padding: 16px 74px;
  border: 1px solid var(--brand-gold-bright);
  border-radius: 3px;
  background: linear-gradient(
    135deg,
    #aa771c 0%,
    #fcf6ba 25%,
    #bf953f 50%,
    #fcf6ba 75%,
    #aa771c 100%
  );
  background-size: 300% 100%;
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.42em;
  color: #16120c;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.22);
  animation: landing-gold-shine 4.8s ease-in-out infinite;
  cursor: pointer;
  transition:
    transform 0.25s cubic-bezier(0.22, 1, 0.36, 1),
    border-color 0.25s ease;
}
.landing__pill:hover {
  transform: scale(1.05);
  border-color: var(--brand-ivory);
  background-position: 100% 50%;
  background: #fcf6ba;
  box-shadow: 0 0 30px var(--brand-gold-soft);
}
.landing__pill:active {
  transform: scale(0.98);
}
.landing__pill:focus-visible,
.formpage__submit:focus-visible {
  outline: 3px solid var(--brand-gold-bright);
  outline-offset: 4px;
}
/* ═══════════ 第二页：登录表单（白底） ═══════════ */
.formpage {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--brand-void);
  color: var(--brand-ivory);
  overflow: hidden;
  isolation: isolate;
  animation: formpage-in 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.formpage::before,
.formpage::after {
  content: '';
  position: absolute;
  z-index: -1;
  width: min(34vw, 440px);
  aspect-ratio: 1;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 50%;
  pointer-events: none;
}
.formpage::before {
  top: -18vw;
  right: -10vw;
}
.formpage::after {
  bottom: -22vw;
  left: -12vw;
}
.formpage__v-mark {
  position: absolute;
  top: 13vh;
  right: 9vw;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: clamp(110px, 15vw, 220px);
  font-weight: 400;
  line-height: 0.7;
  color: rgba(201, 155, 75, 0.16);
  transform: rotate(8deg);
  user-select: none;
  pointer-events: none;
}
@keyframes formpage-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.formpage__inner {
  width: min(400px, calc(100vw - 48px));
  animation: card-rise 0.6s 0.08s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes card-rise {
  from {
    opacity: 0;
    transform: translateY(16px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.formpage__store {
  margin: 0 0 22px;
  margin-left: auto;
  margin-right: auto;
  width: fit-content;
  font-size: clamp(26px, 3.2vw, 40px);
  font-weight: 700;
  letter-spacing: 0.01em;
  color: var(--brand-ivory);
  white-space: nowrap;
}
.formpage__card {
  padding: 30px 32px 30px;
  background: var(--brand-void-2);
  border: 1px solid color-mix(in srgb, var(--brand-gold-on-dark) 34%, transparent);
  border-radius: 16px;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.28);
}
.formpage__alert {
  margin-bottom: 14px;
}
.formpage__field {
  margin-bottom: 14px;
}
.formpage__field :deep(.el-input__wrapper) {
  height: 48px;
  background: var(--brand-void);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 12px;
  box-shadow: none;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}
.formpage__field :deep(.el-input__wrapper:hover) {
  border-color: var(--brand-gold-on-dark);
}
.formpage__field :deep(.el-input__wrapper.is-focus) {
  border-color: var(--brand-gold-on-dark);
  box-shadow: 0 0 0 3px var(--brand-gold-soft);
}
.formpage__field :deep(.el-input__inner) {
  font-size: 15px;
  letter-spacing: 0.02em;
  color: var(--brand-ivory);
}
.formpage__field :deep(.el-input__inner::placeholder) {
  color: rgba(245, 246, 248, 0.48);
}
.formpage__submit {
  width: 100%;
  height: 48px;
  margin-top: 8px;
  border: none;
  border-radius: 3px;
  background: linear-gradient(
    120deg,
    #aa771c 0%,
    #fcf6ba 25%,
    #bf953f 50%,
    #fcf6ba 75%,
    #aa771c 100%
  );
  background-size: 300% 100%;
  color: var(--brand-void);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.3em;
  transition:
    transform 0.2s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.2s ease;
  animation: landing-gold-shine 4.8s ease-in-out infinite;
}
.formpage__submit:hover {
  opacity: 1;
  background: var(--brand-gold-bright);
  color: var(--brand-void);
}
.formpage__submit:active {
  transform: scale(0.97);
}
.formpage__footer {
  position: absolute;
  bottom: 24px;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 12px;
}
.formpage__logo {
  height: 40px;
  width: 40px;
  border-radius: 9px;
  object-fit: cover;
  border: 1px solid rgba(255, 255, 255, 0.14);
}
.formpage__foot-text {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.04em;
  color: rgba(245, 246, 248, 0.55);
}

/* ═══════════ 黑圆扩张转场 ═══════════ */
.login-cover {
  position: fixed;
  z-index: 3000;
  border-radius: 9999px;
  background: var(--brand-void);
  box-shadow: 0 0 0 5px var(--brand-gold);
  opacity: 1;
  transform: scale(0.02);
  pointer-events: none;
}
.login-cover--open {
  transition:
    transform 0.64s cubic-bezier(0.23, 1, 0.32, 1),
    opacity 0.18s ease-out;
  transform: scale(1);
  opacity: 1;
}
.login-cover--fade {
  transition: opacity 0.36s ease-out;
  opacity: 0;
}

/* 减弱动效：保留静态标题、品牌 V 和粒子首帧 */
@media (prefers-reduced-motion: reduce) {
  .landing__v-mark {
    transform: none;
  }
  .landing__title {
    animation: none;
  }
  .landing__particles {
    opacity: 0.42;
  }
  .landing__pill,
  .formpage__submit,
  .formpage,
  .formpage__inner,
  .login-cover--open {
    transition-duration: 0.01s;
    animation-duration: 0.01s;
  }
}
@media (max-width: 700px) {
  .landing__brandline {
    top: 22px;
    left: 22px;
  }
  .landing__title-wrap,
  .landing__sub,
  .landing__product {
    width: calc(100vw - 44px);
  }
  .landing__title {
    font-size: clamp(34px, 10vw, 58px);
    white-space: normal;
  }
  .landing__pill {
    margin-left: 0;
    padding-inline: 42px;
  }
}
</style>
