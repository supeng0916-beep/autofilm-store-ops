<script setup lang="ts">
// 经营复盘（M10 最小版）：漏斗/成交收入/来源归因/流失原因/技师产能。
// 轻量条形图（纯 CSS，零图表库依赖）；老板/店长看全局，销售仅本人范围（后端过滤，标题提示）。
import { onMounted, ref } from 'vue';

import { analyticsApi, STAGE_LABEL, type AnalyticsOverview } from '../api/analytics';
import EmptyState from '../components/ui/EmptyState.vue';
import PageHeader from '../components/ui/PageHeader.vue';
import WgHintIcon from '../components/ui/WgHintIcon.vue';
import StatCard from '../components/ui/StatCard.vue';

const data = ref<AnalyticsOverview | null>(null);
const loading = ref(false);
// 2026-08-27 Q1：原「本月 vs 近30天」高度重合——改为互斥递进：今日/本周/本月/今年/全部（默认本月）
const rangeKey = ref<'today' | 'week' | 'month' | 'year' | 'all'>('month');

const fmtFen = (fen: number | null) =>
  fen === null ? '-' : `¥${(fen / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const label = (s: string) => STAGE_LABEL[s] ?? s;

const ranges = (): { from?: string; to?: string } => {
  const to = new Date();
  const iso = (d: Date) => d.toISOString();
  if (rangeKey.value === 'today') {
    return { from: iso(new Date(to.getFullYear(), to.getMonth(), to.getDate())), to: iso(to) };
  }
  if (rangeKey.value === 'week') {
    const day = (to.getDay() + 6) % 7; // 周一为一周之始
    return {
      from: iso(new Date(to.getFullYear(), to.getMonth(), to.getDate() - day)),
      to: iso(to),
    };
  }
  if (rangeKey.value === 'year') {
    return { from: iso(new Date(to.getFullYear(), 0, 1)), to: iso(to) };
  }
  if (rangeKey.value === 'month') {
    const from = new Date(to.getFullYear(), to.getMonth(), 1);
    return { from: from.toISOString(), to: to.toISOString() };
  }
  return {};
};

const load = async () => {
  loading.value = true;
  try {
    data.value = await analyticsApi.overview(ranges());
  } finally {
    loading.value = false;
  }
};

/** 漏斗条宽度：相对总数 */
const barWidth = (n: number) => {
  const total = data.value?.funnel.total ?? 0;
  return total > 0 ? `${Math.max((n / total) * 100, 2)}%` : '0%';
};

const funnelSteps = () => {
  const f = data.value?.funnel;
  if (!f) return [];
  return [
    { label: '客资进入', count: f.total, rate: '' },
    { label: '已触达', count: f.touched, rate: `触达率 ${pct(f.touchRate)}` },
    { label: '已到店', count: f.visited, rate: `到店率 ${pct(f.visitRate)}（按已触达）` },
    { label: '已成交', count: f.won, rate: `成交率 ${pct(f.closeRate)}` },
  ];
};

const maxStageCount = () => Math.max(1, ...(data.value?.byStage.map((s) => s.count) ?? [1]));

onMounted(load);
</script>

<template>
  <div v-loading="loading" class="analytics wg-page">
    <PageHeader title="经营复盘" sub="客资漏斗 / 成交收入 / 来源归因 / 技师产能">
      <template #actions>
        <el-tag v-if="data?.range.scopedToOwner" size="small" type="info">本人范围</el-tag>
        <el-radio-group v-model="rangeKey" size="small" @change="load">
          <el-radio-button value="today">今日</el-radio-button>
          <el-radio-button value="week">本周</el-radio-button>
          <el-radio-button value="month">本月</el-radio-button>
          <el-radio-button value="year">今年</el-radio-button>
          <el-radio-button value="all">全部</el-radio-button>
        </el-radio-group>
      </template>
    </PageHeader>

    <template v-if="data">
      <!-- 关键指标 -->
      <div class="cards">
        <StatCard label="客资总数" :value="data.funnel.total" />
        <StatCard label="成交" :value="data.funnel.won" :tip="`流失 ${data.funnel.lost}`" />
        <StatCard
          label="成交额"
          :value="fmtFen(data.revenueFen)"
          :tip="`均单 ${fmtFen(data.avgDealFen)}（口径：范围内核记成交客资的成交价合计）`"
        />
        <StatCard
          label="成交率"
          :value="pct(data.funnel.closeRate)"
          :tip="`成交周期 ${data.funnel.avgCloseDays ?? '-'} 天`"
        />
        <StatCard
          label="施工交付"
          :value="`${data.workOrders.delivered}/${data.workOrders.total}`"
          :tip="`返工率 ${pct(data.workOrders.reworkRate)}`"
        />
      </div>

      <!-- 财务收支（批次2 T8） -->
      <div class="cards">
        <StatCard
          label="收入（手工流水）"
          :value="fmtFen(data.finance.incomeFen)"
          tip="口径：财务收支页登记的实际收付"
        />
        <StatCard label="支出（手工流水）" :value="fmtFen(data.finance.expenseFen)" />
        <StatCard
          label="结余"
          :value="fmtFen(data.finance.netFen)"
          :tip="data.finance.netFen < 0 ? '支大于收' : '收大于支'"
        />
        <!-- 毛利估算（批次4）：null（无已录成本的确认订单/销售视角）显"—" -->
        <StatCard
          label="毛利估算"
          :value="data.grossProfitFen === null ? '—' : fmtFen(data.grossProfitFen)"
          tip="口径：已录材料成本的已确认订单 收款−成本"
        />
      </div>

      <div class="grid">
        <!-- 内容归因（批次2 T8） -->
        <section class="panel">
          <h3>内容归因</h3>
          <el-table
            v-if="data.contentAttribution.length"
            :data="data.contentAttribution"
            size="small"
          >
            <el-table-column label="内容" min-width="150">
              <template #default="{ row }">{{ row.title ?? row.contentId }}</template>
            </el-table-column>
            <el-table-column prop="platform" label="平台" width="90" />
            <el-table-column prop="leadCount" label="客资数" width="80" align="right" />
            <el-table-column prop="wonCount" label="成交数" width="80" align="right" />
            <el-table-column label="成交额" width="110" align="right">
              <template #default="{ row }">{{ fmtFen(row.revenueFen) }}</template>
            </el-table-column>
            <el-table-column label="投流费" width="100" align="right">
              <template #default="{ row }">{{ fmtFen(row.costFen) }}</template>
            </el-table-column>
          </el-table>
          <EmptyState v-else desc="客资导入时带内容编号、营销页登记内容台账后可见归因" />
        </section>

        <!-- 客户画像（批次2 T8） -->
        <section class="panel">
          <h3>客户画像</h3>
          <!-- 复购客户（批次6）：口径＝范围内成交≥2 条客资的客户数 -->
          <p class="repeat-line">
            复购客户 <span class="repeat-line__num">{{ data.repeatCustomerCount }}</span> 位
            <span class="wg-muted">（成交≥2 条客资）</span>
          </p>
          <template v-if="data.profile.gender.length || data.profile.ageBand.length">
            <div v-for="row in data.profile.gender" :key="`g-${row.value}`" class="funnel-row">
              <div class="funnel-meta">
                <span>{{
                  row.value === 'male' ? '男' : row.value === 'female' ? '女' : row.value
                }}</span>
                <span class="wg-muted">{{ row.count }}</span>
              </div>
              <div class="funnel-track">
                <div class="funnel-bar" :style="{ width: barWidth(row.count) }" />
              </div>
            </div>
            <div v-for="row in data.profile.ageBand" :key="`a-${row.value}`" class="funnel-row">
              <div class="funnel-meta">
                <span>{{ row.value }} 岁</span>
                <span class="wg-muted">{{ row.count }}</span>
              </div>
              <div class="funnel-track">
                <div class="funnel-bar" :style="{ width: barWidth(row.count) }" />
              </div>
            </div>
            <p class="wg-muted" style="font-size: 12px">仅统计填写画像的客资</p>
          </template>
          <EmptyState v-else desc="客资详情填写画像（性别/年龄段等）后可见分布" />
        </section>
        <!-- 漏斗 -->
        <section class="panel">
          <h3>客资漏斗</h3>
          <div v-for="step in funnelSteps()" :key="step.label" class="funnel-row">
            <div class="funnel-meta">
              <span>{{ step.label }}</span>
              <span class="wg-muted">{{ step.count }} ｜ {{ step.rate }}</span>
            </div>
            <div class="funnel-track">
              <div class="funnel-bar" :style="{ width: barWidth(step.count) }" />
            </div>
          </div>
          <EmptyState
            v-if="data.funnel.total === 0"
            desc="该时间段暂无客资数据（导入客资后自动统计）"
          />
        </section>

        <!-- 阶段分布 -->
        <section class="panel">
          <h3>客资状态分布</h3>
          <div v-for="row in data.byStage" :key="row.stage" class="funnel-row">
            <div class="funnel-meta">
              <span>{{ label(row.stage) }}</span>
              <span class="wg-muted">{{ row.count }}</span>
            </div>
            <div class="funnel-track">
              <div
                class="funnel-bar alt"
                :style="{ width: `${(row.count / maxStageCount()) * 100}%` }"
              />
            </div>
          </div>
          <div v-if="data.byFinalStatus.length" class="final-tags">
            <el-tag v-for="f in data.byFinalStatus" :key="f.stage" size="small" class="tag">
              {{ label(f.stage) }} {{ f.count }}
            </el-tag>
          </div>
        </section>

        <!-- 来源归因 -->
        <section class="panel">
          <h3>来源渠道</h3>
          <el-table :data="data.bySource" size="small" class="wg-table">
            <el-table-column prop="platform" label="渠道" min-width="110" />
            <el-table-column prop="total" label="客资" width="70" />
            <el-table-column prop="won" label="成交" width="70" />
            <el-table-column label="成交额" width="110">
              <template #default="{ row }">{{ fmtFen(row.revenueFen) }}</template>
            </el-table-column>
          </el-table>
          <h3 class="panel__sub">流失原因 Top5</h3>
          <el-table :data="data.lostReasons" size="small" class="wg-table">
            <el-table-column prop="reason" label="原因" min-width="140" />
            <el-table-column prop="count" label="次数" width="70" />
          </el-table>
          <p v-if="data.lostReasons.length === 0" class="wg-muted">暂无流失记录</p>
        </section>

        <!-- 技师产能 -->
        <section class="panel">
          <h3>技师产能<WgHintIcon k="analytics.techTable" /></h3>
          <el-table :data="data.workOrders.byTechnician" size="small" class="wg-table">
            <el-table-column prop="name" label="技师" min-width="90" />
            <el-table-column prop="total" label="施工单" width="70" />
            <el-table-column prop="delivered" label="交付" width="60" />
            <el-table-column prop="rework" label="返工" width="60" />
            <el-table-column label="产值" width="110">
              <template #default="{ row }">{{ fmtFen(row.revenueFen) }}</template>
            </el-table-column>
          </el-table>
          <p v-if="data.workOrders.byTechnician.length === 0" class="wg-muted">暂无施工单数据</p>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: 16px;
}
/* 分析面板卡片（V2.5 令牌：白卡 + hairline + 18px 圆角 + 零阴影） */
.panel {
  border: 1px solid var(--wg-hairline);
  border-radius: 18px;
  padding: 20px;
  background: var(--wg-surface);
}
.panel h3 {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--wg-ink);
}
.panel__sub {
  margin-top: 16px;
}
.funnel-row {
  margin-bottom: 10px;
}
/* 复购客户行（批次6）：画像面板首行小字，数字用主色微强调 */
.repeat-line {
  margin: 0 0 12px;
  font-size: 13px;
}
.repeat-line__num {
  font-weight: 600;
  color: var(--wg-primary);
}
.funnel-meta {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  margin-bottom: 4px;
}
.funnel-track {
  height: 10px;
  border-radius: 9999px;
  background: var(--wg-divider-soft);
  overflow: hidden;
}
/* 漏斗条色（V2.5）：主蓝 + 灰次 */
.funnel-bar {
  height: 100%;
  border-radius: 9999px;
  background: var(--wg-primary);
}
.funnel-bar.alt {
  background: var(--wg-ink-muted);
}
.final-tags {
  margin-top: 8px;
}
.tag {
  margin: 0 6px 6px 0;
}
</style>
