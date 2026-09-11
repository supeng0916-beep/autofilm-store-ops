<script setup lang="ts">
// 客资详情子组件（P3-06 / V2.5 Task3）：左栏客资字段卡＋SLA（纯展示）。
// chatLink 仅 boss/store_manager 有值才渲染（后端已按角色脱敏）。
import type { LeadDetail } from '../../api/leads';
import { FINAL_STATUS_LABELS, STAGE_LABELS } from './leadDisplay';
import { computed } from 'vue';

const props = defineProps<{ lead: LeadDetail | null }>();

/** 画像摘要（批次2 T8）：性别+年龄段，空显 — */
const profileText = computed(() => {
  if (!props.lead) return '—';
  const g = props.lead.gender === 'male' ? '男' : props.lead.gender === 'female' ? '女' : null;
  const parts = [g, props.lead.ageBand ? `${props.lead.ageBand} 岁` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
});

function slaText(): string {
  const sla = props.lead?.sla;
  if (!sla) return '—';
  if (sla.state === 'done') return '已触达';
  if (sla.state === 'na') return '—';
  if (sla.state === 'breach') return '已违约';
  if (sla.state === 'escalate') return '已升级';
  return sla.state === 'remind'
    ? `已提醒（${sla.dueInMinutes ?? 0} 分钟）`
    : `${sla.dueInMinutes ?? 0} 分钟`;
}
</script>

<template>
  <section class="wg-card lead-card">
    <h3 class="wg-card-title lead-card__title">客资信息</h3>
    <template v-if="lead">
      <p class="lead-card__field"><span class="lead-card__label">画像</span>{{ profileText }}</p>
      <p class="lead-card__field">
        <span class="lead-card__label">行业</span>{{ lead.industry ?? '—' }}
      </p>
      <p class="lead-card__field">
        <span class="lead-card__label">住所方位</span>{{ lead.district ?? '—' }}
      </p>
      <p class="lead-card__field">
        <span class="lead-card__label">购车门店</span>{{ lead.purchaseDealer ?? '—' }}
      </p>
      <p class="lead-card__field">
        <span class="lead-card__label">内容编号</span>{{ lead.contentId ?? '—' }}
      </p>
      <p class="lead-card__field"><span class="lead-card__label">编号</span>{{ lead.leadNo }}</p>
      <p class="lead-card__field lead-card__field--oneline" :title="lead.customerName ?? ''">
        <span class="lead-card__label">称呼</span>{{ lead.customerName ?? '未确认' }}
      </p>
      <p class="lead-card__field">
        <span class="lead-card__label">电话</span>{{ lead.phone ?? '—' }}
      </p>
      <p class="lead-card__field">
        <span class="lead-card__label">微信</span>{{ lead.wechat ?? '—' }}
      </p>
      <!-- chatLink 仅 boss/store_manager 有值才渲染（后端已按角色脱敏） -->
      <p v-if="lead.chatLink" class="lead-card__field">
        <span class="lead-card__label">聊天链接</span>
        <a :href="lead.chatLink" target="_blank" rel="noopener noreferrer">打开</a>
      </p>
      <p class="lead-card__field">
        <span class="lead-card__label">来源</span>{{ lead.sourcePlatform }}
      </p>
      <p class="lead-card__field">
        <span class="lead-card__label">业务</span>{{ lead.businessType }}
      </p>
      <p class="lead-card__field lead-card__field--oneline" :title="lead.target ?? ''">
        <span class="lead-card__label">对象</span>{{ lead.target ?? '—' }}
      </p>
      <p class="lead-card__field lead-card__field--clamp" :title="lead.productNeed ?? ''">
        <span class="lead-card__label">需求</span>{{ lead.productNeed ?? '—' }}
      </p>
      <p class="lead-card__field lead-card__field--clamp" :title="lead.rawNeed ?? ''">
        <span class="lead-card__label">原话</span>{{ lead.rawNeed ?? '—' }}
      </p>
      <p class="lead-card__field">
        <span class="lead-card__label">阶段</span>{{ STAGE_LABELS[lead.stage] ?? lead.stage }}
      </p>
      <p class="lead-card__field">
        <span class="lead-card__label">状态</span
        >{{ FINAL_STATUS_LABELS[lead.finalStatus] ?? lead.finalStatus }}
      </p>
      <p class="lead-card__field lead-card__field--clamp" :title="lead.lastFollowUpResult ?? ''">
        <span class="lead-card__label">最近跟进</span>{{ lead.lastFollowUpResult ?? '—' }}
      </p>
      <p class="lead-card__field"><span class="lead-card__label">SLA</span>{{ slaText() }}</p>
    </template>
    <p v-else class="lead-card__empty">暂无客资</p>
  </section>
</template>

<style scoped>
.lead-card__title {
  font-size: 17px;
  margin-bottom: 12px;
}
.lead-card__field {
  margin: 4px 0;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-all;
}
.lead-card__label {
  display: inline-block;
  min-width: 64px;
  color: var(--wg-ink-muted);
}
/* 长文本防撑爆（2026-08-28 UI 测试 #11）：200 字称呼/车型曾把左栏撑满、右栏挤压变形。
 * 短字段单行省略；需求/原话/最近跟进三行封顶；悬停 title 看全文。 */
.lead-card__field--oneline {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lead-card__field--clamp {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}
.lead-card__empty {
  color: var(--wg-ink-muted);
  font-size: 13px;
}
</style>
