<script setup lang="ts">
// 技师卡（V2.4 Task 3 拆件）：档案（名/停用灰标/技能 tags）+ 忙闲状态 + 四指标 + 五维 CSS 雷达。
// 雷达归一值（0-1）由父视图按组内 max 计算后经 radar prop 传入，本组件只负责几何绘制。
import { computed } from 'vue';

import { TECHNICIAN_SKILL_LABEL, type TechnicianCard } from '../api/team';
import { WO_STAGE_LABEL } from '../api/workOrder';

const props = defineProps<{
  technician: TechnicianCard;
  /** 五维归一值（施工量/交付率/低返工/产值/活跃，0-1，组内 max 归一） */
  radar: number[];
  /** 写权限（近似口径 approval:decide）：控制改名/技能按钮显隐 */
  canManage?: boolean;
}>();

const emit = defineEmits<{ rename: []; editSkills: [] }>();

/** 技能 tags：skills 为工种枚举数组（V1.5 契约），经 LABEL 映射中文；未知值原样展示 */
const skillTags = computed(() =>
  (props.technician.skills ?? []).map((s) => TECHNICIAN_SKILL_LABEL[s] ?? s),
);

/** 忙闲文案（2026-08-28 口径修复）：非终态单显示真实阶段（待入场/施工中/自检/复检）+单号 */
const busyText = computed(() => {
  const cur = props.technician.currentWorkOrder;
  return cur ? `🛠 ${WO_STAGE_LABEL[cur.stage] ?? cur.stage} ${cur.orderNo}` : '';
});

/** 产值分转元（analytics fmtFen 同口径） */
const fmtFen = (fen: number) =>
  `¥${(fen / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;

// —— 五维雷达几何：容器 160px，半径 70，正上为第 0 维顶点，顺时针每 72° ——
const CX = 80;
const CY = 80;
const R = 70;
const DIMS = 5;
const at = (i: number, radius: number) => {
  const angle = -Math.PI / 2 + (i * 2 * Math.PI) / DIMS;
  return `${(CX + radius * Math.cos(angle)).toFixed(1)}px ${(CY + radius * Math.sin(angle)).toFixed(1)}px`;
};
/** 外框五边形与 1/2 半径参考环（clip-path 裁切填充色，无图表库） */
const frame = Array.from({ length: DIMS }, (_, i) => at(i, R)).join(', ');
const midRing = Array.from({ length: DIMS }, (_, i) => at(i, R / 2)).join(', ');
/** 值域多边形：归一 0-1 → 半径（下限 4% 半径，零值仍可见贴中心） */
const valueShape = computed(() =>
  props.radar.map((v, i) => at(i, Math.max(Math.min(v, 1), 0.04) * R)).join(', '),
);

/** 图例小字：五维名称（顺序同雷达顶点，自正上顺时针） */
const RADAR_LEGEND = '施工量 · 交付率 · 低返工 · 产值 · 活跃';
</script>

<template>
  <div class="tech-card" :class="{ 'tech-card--off': !technician.active }">
    <div class="tech-card__head">
      <span class="tech-card__name">{{ technician.name }}</span>
      <el-tag v-if="!technician.active" size="small" type="info">停用</el-tag>
      <el-button v-if="canManage" link size="small" type="primary" @click="emit('rename')">
        改名
      </el-button>
      <el-button v-if="canManage" link size="small" type="primary" @click="emit('editSkills')">
        技能
      </el-button>
    </div>
    <div v-if="skillTags.length" class="tech-card__skills">
      <el-tag v-for="s in skillTags" :key="s" size="small" effect="plain">{{ s }}</el-tag>
    </div>
    <div class="tech-card__status">
      <template v-if="technician.currentWorkOrder">
        <span class="tech-card__busy">{{ busyText }}</span>
      </template>
      <template v-else><span class="tech-card__dot" />空闲</template>
    </div>
    <div class="tech-card__stats">
      <div class="tech-card__stat">
        <b>{{ technician.stats.total }}</b>
        <span>施工</span>
      </div>
      <div class="tech-card__stat">
        <b>{{ technician.stats.delivered }}</b>
        <span>交付</span>
      </div>
      <div class="tech-card__stat">
        <b>{{ technician.stats.rework }}</b>
        <span>返工</span>
      </div>
      <div class="tech-card__stat">
        <b>{{ fmtFen(technician.stats.revenueFen) }}</b>
        <span>产值</span>
      </div>
    </div>
    <div class="tech-card__radar">
      <div class="tech-card__radar-shape">
        <div class="tech-card__radar-frame" :style="{ clipPath: `polygon(${frame})` }" />
        <div class="tech-card__radar-mid" :style="{ clipPath: `polygon(${midRing})` }" />
        <div class="tech-card__radar-value" :style="{ clipPath: `polygon(${valueShape})` }" />
      </div>
      <div class="tech-card__radar-legend">{{ RADAR_LEGEND }}</div>
    </div>
  </div>
</template>

<style scoped>
.tech-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  background: #fff;
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
}
/* 停用：整卡降饱和（灰标留痕不删） */
.tech-card--off {
  opacity: 0.55;
}
.tech-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tech-card__name {
  font-weight: 600;
  color: var(--wg-ink);
}
.tech-card__head .el-button {
  margin-left: auto;
}
.tech-card__skills {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.tech-card__status {
  font-size: 13px;
}
.tech-card__busy {
  color: var(--wg-ink);
  font-weight: 600;
}
/* 空闲绿点 */
.tech-card__dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 4px;
  background: var(--el-color-success);
  border-radius: 50%;
}
.tech-card__stats {
  display: grid;
  /* V2.6 布局修复：窄卡自动降列，避免 4 列固定在窄容器内挤压溢出 */
  grid-template-columns: repeat(auto-fit, minmax(64px, 1fr));
  gap: 4px;
  text-align: center;
}
.tech-card__stat b {
  display: block;
  font-size: 15px;
  color: var(--wg-ink);
}
.tech-card__stat span {
  font-size: 12px;
  color: var(--wg-ink-muted);
}
.tech-card__radar {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.tech-card__radar-shape {
  position: relative;
  width: 160px;
  height: 160px;
}
.tech-card__radar-shape > div {
  position: absolute;
  inset: 0;
}
.tech-card__radar-frame {
  background: var(--wg-canvas);
}
.tech-card__radar-mid {
  background: var(--el-border-color-light);
  opacity: 0.6;
}
/* 值域填充：主题蓝半透明（color-mix 兼容面不稳，直接 rgba） */
.tech-card__radar-value {
  background: rgba(64, 158, 255, 0.4);
}
.tech-card__radar-legend {
  margin-top: 2px;
  font-size: 11px;
  color: var(--wg-ink-muted);
}
</style>
