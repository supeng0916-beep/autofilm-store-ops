<script setup lang="ts">
/* global window, setTimeout */
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useAuthStore } from '../stores/auth';

/** 登录后的过渡页（2026-08-21 品牌化）：欢迎语 + 进度条；
 * 无论加载多快都保持 minMs（默认 2.2s ≥ 需求 2s），随后淡出进入工作台。 */
const props = withDefaults(defineProps<{ minMs?: number }>(), { minMs: 2200 });

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const leaving = ref(false);

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

onMounted(async () => {
  await wait(props.minMs);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduced) {
    leaving.value = true;
    await wait(380); // 淡出动画时长（与样式保持一致）
  }
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
  await router.replace(redirect);
});
</script>

<template>
  <div class="splash" :class="{ 'is-leaving': leaving }">
    <div class="splash__air" aria-hidden="true" />
    <div class="splash__metal-ring" aria-hidden="true" />
    <div class="splash__v-mark" aria-hidden="true">A</div>
    <div class="splash__v-glint" aria-hidden="true" />
    <div class="splash__axis splash__axis--x" aria-hidden="true" />
    <div class="splash__axis splash__axis--y" aria-hidden="true" />
    <div class="splash__scanline" aria-hidden="true" />
    <div class="splash__center">
      <p class="splash__eyebrow"><span>AI</span><i />AutoFilm Ops · AI经营协同系统</p>
      <h1 class="splash__welcome">{{ auth.user?.displayName ?? '' }}，欢迎你！</h1>
      <p class="splash__sub">从这里开启和 AI 一起工作的时代</p>
      <div class="splash__bar" aria-hidden="true"><span /><b /></div>
    </div>
    <p class="splash__foot"><span>AutoFilm Demo</span><i />门店助手 v0.1</p>
  </div>
</template>

<style scoped>
/* Apple 白色简约过渡页（与登录页同语法）：羊米色画布 + 墨色紧排 + Action Blue 进度条 */
.splash {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--brand-void);
  color: var(--brand-ivory);
  overflow: hidden;
  isolation: isolate;
  opacity: 1;
  transition: opacity 0.38s ease;
}
.splash::before {
  content: '';
  position: absolute;
  inset: 22px;
  border: 1px solid color-mix(in srgb, var(--brand-gold-on-dark) 28%, transparent);
  pointer-events: none;
}
.splash::after {
  content: '';
  position: absolute;
  inset: 0;
  opacity: 0.16;
  background: repeating-linear-gradient(
    0deg,
    transparent 0,
    transparent 5px,
    rgba(255, 255, 255, 0.08) 6px,
    transparent 7px
  );
  mix-blend-mode: screen;
  pointer-events: none;
}
.splash.is-leaving {
  opacity: 0;
}
.splash__air {
  position: absolute;
  top: -24vw;
  left: 50%;
  width: min(72vw, 980px);
  height: min(72vw, 980px);
  transform: translateX(-50%);
  border-radius: 9999px;
  border: 1px solid color-mix(in srgb, var(--brand-gold-bright) 42%, transparent);
  animation: splash-air 26s ease-in-out infinite alternate;
  pointer-events: none;
}
.splash__air::before,
.splash__air::after {
  content: '';
  position: absolute;
  inset: 12%;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: inherit;
}
.splash__air::after {
  inset: 26%;
  border-color: color-mix(in srgb, var(--brand-gold-bright) 82%, transparent);
}
@keyframes splash-air {
  from {
    transform: translateX(-50%) scale(1);
  }
  to {
    transform: translateX(-46%) scale(1.12);
  }
}
.splash__metal-ring {
  position: absolute;
  top: 50%;
  left: 50%;
  width: min(44vw, 620px);
  aspect-ratio: 1;
  border: 1px solid color-mix(in srgb, var(--brand-gold-bright) 64%, transparent);
  border-radius: 50%;
  box-shadow:
    0 0 0 12px rgba(210, 166, 83, 0.05),
    0 0 0 13px rgba(210, 166, 83, 0.18);
  transform: translate(-50%, -50%) rotate(-12deg);
  pointer-events: none;
}
.splash__metal-ring::before,
.splash__metal-ring::after {
  content: '';
  position: absolute;
  inset: 8%;
  border: 1px dashed rgba(210, 166, 83, 0.48);
  border-radius: 50%;
}
.splash__metal-ring::after {
  inset: 18%;
  border-style: solid;
  border-color: rgba(255, 255, 255, 0.14);
}
.splash__v-mark {
  position: absolute;
  z-index: 1;
  top: 50%;
  left: 50%;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: min(42vw, 560px);
  font-weight: 700;
  line-height: 0.7;
  letter-spacing: -0.08em;
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
  -webkit-text-stroke: 2px #e0b35a;
  text-shadow:
    0 2px 0 var(--brand-gold-deep),
    0 0 22px var(--brand-gold-soft);
  transform: translate(-50%, -50%) rotate(-8deg);
  animation: splash-gold-shine 5.2s ease-in-out infinite;
  user-select: none;
  pointer-events: none;
}
@keyframes splash-gold-shine {
  0%,
  100% {
    background-position: 0% 50%;
  }
  50% {
    background-position: 100% 50%;
  }
}
.splash__v-glint {
  position: absolute;
  z-index: 2;
  top: 50%;
  left: 50%;
  width: min(38vw, 520px);
  height: 2px;
  background: var(--brand-ivory);
  box-shadow: 0 0 14px var(--brand-gold-bright);
  transform: translate(-50%, -50%) rotate(-28deg);
  animation: splash-glint 5.4s ease-in-out infinite;
  pointer-events: none;
}
@keyframes splash-glint {
  0%,
  34% {
    opacity: 0;
    transform: translate(-62%, -50%) rotate(-28deg);
  }
  48%,
  58% {
    opacity: 0.92;
  }
  72%,
  100% {
    opacity: 0;
    transform: translate(6%, -50%) rotate(-28deg);
  }
}
.splash__axis {
  position: absolute;
  z-index: 0;
  background: color-mix(in srgb, var(--brand-gold-bright) 18%, transparent);
  pointer-events: none;
}
.splash__axis--x {
  top: 50%;
  left: 0;
  width: 100%;
  height: 1px;
}
.splash__axis--y {
  top: 0;
  left: 50%;
  width: 1px;
  height: 100%;
}
.splash__center {
  position: relative;
  z-index: 3;
  text-align: center;
  animation: splash-in 0.8s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes splash-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.splash__eyebrow {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin: 0 0 22px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.2em;
  color: color-mix(in srgb, var(--brand-ivory) 78%, transparent);
}
.splash__eyebrow span {
  color: var(--brand-gold-bright);
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 17px;
  letter-spacing: 0.04em;
}
.splash__eyebrow i,
.splash__foot i {
  display: block;
  width: 24px;
  height: 1px;
  background: color-mix(in srgb, var(--brand-gold-bright) 70%, transparent);
}
.splash__welcome {
  margin: 0;
  font-size: clamp(34px, 4.2vw, 62px);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.18;
  color: var(--brand-ivory);
  text-shadow: 0 2px 24px rgba(0, 0, 0, 0.26);
}
.splash__sub {
  margin: 16px 0 0;
  font-size: clamp(17px, 1.6vw, 24px);
  font-weight: 400;
  letter-spacing: 0.1em;
  color: color-mix(in srgb, var(--brand-ivory) 66%, transparent);
}
.splash__bar {
  position: relative;
  width: 280px;
  height: 3px;
  margin: 46px auto 0;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.13);
  overflow: hidden;
}
.splash__bar span {
  display: block;
  height: 100%;
  border-radius: 3px;
  position: relative;
  z-index: 1;
  background: var(--brand-gold-bright);
  box-shadow: 0 0 10px rgba(210, 166, 83, 0.7);
  animation: splash-bar 2.2s linear forwards;
}
.splash__bar b {
  position: absolute;
  top: -3px;
  left: 0;
  width: 7px;
  height: 9px;
  border: 1px solid #f3d28a;
  border-radius: 50%;
  box-shadow: 0 0 10px rgba(243, 210, 138, 0.9);
  animation: splash-bar-node 2.2s linear forwards;
}
@keyframes splash-bar-node {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(273px);
  }
}
@keyframes splash-bar {
  from {
    width: 4%;
  }
  to {
    width: 100%;
  }
}
.splash__foot {
  position: absolute;
  bottom: 26px;
  left: 0;
  right: 0;
  margin: 0;
  text-align: center;
  font-size: 12px;
  letter-spacing: 0.06em;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: color-mix(in srgb, var(--brand-ivory) 48%, transparent);
}
.splash__foot span {
  color: color-mix(in srgb, var(--brand-ivory) 70%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .splash__air,
  .splash__v-glint,
  .splash__center,
  .splash__bar span,
  .splash__bar b {
    animation: none;
  }
  .splash__bar span {
    width: 100%;
  }
  .splash__bar b {
    transform: translateX(273px);
  }
  .splash__v-mark {
    animation: none;
  }
}
@media (prefers-reduced-transparency: reduce) {
  .splash__air,
  .splash__air::before,
  .splash__air::after {
    border-color: rgba(210, 166, 83, 0.72);
  }
}
</style>
