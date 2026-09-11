<script setup lang="ts">
// 销售陪练（V1.5 批次6a）：全员共用练功房——选剧本开局 → AI 演客户回合制对话 → 结束教练点评。
// 全员可用（无权限点）；对话原文落库审计，点评含优点/改进/示范话术；失败降级提示不重试轰炸。
import { ElMessage } from 'element-plus';

import WgHintIcon from '../components/ui/WgHintIcon.vue';
import { ref } from 'vue';

import {
  DIFFICULTIES,
  SCENARIOS,
  roleplayApi,
  type RoleplayMood,
  type RoleplayReview,
  type RoleplayTurn,
} from '../api/roleplay';

const MOOD_LABEL: Record<RoleplayMood, string> = {
  interested: '客户有兴趣',
  neutral: '客户在听',
  annoyed: '客户不耐烦',
  close_deal_hint: '客户想成交',
};

const scenario = ref<string>('first_touch');
const difficulty = ref<string>('normal');
const carModel = ref('');
const sessionId = ref('');
const turns = ref<RoleplayTurn[]>([]);
const lastMood = ref<RoleplayMood | null>(null);
const input = ref('');
const busy = ref(false);
const starting = ref(false);
const review = ref<RoleplayReview | null>(null);
// 自评 1~5 星：el-rate 的 modelValue 类型为 number | undefined（清空用 undefined，非 null）
const selfScore = ref<number | undefined>(undefined);
const extracting = ref(false);
const extractNote = ref('');
const feedText = ref('');
const feeding = ref(false);

async function extract(fromSession: boolean): Promise<void> {
  if (extracting.value || feeding.value) return;
  if (fromSession) {
    extracting.value = true;
  } else {
    feeding.value = true;
  }
  try {
    const res = await roleplayApi.extract(
      fromSession ? { sessionId: sessionId.value } : { rawText: feedText.value },
    );
    if (res.rejected) {
      extractNote.value = `这次没提炼出经验卡：${res.reason ?? '素材太薄'}`;
    } else {
      extractNote.value = `经验卡「${res.item?.title}」已存为建议草稿，等老板审批后全店共享`;
      if (!fromSession) feedText.value = '';
    }
  } catch {
    extractNote.value = '提炼暂不可用，请稍后再试';
  } finally {
    extracting.value = false;
    feeding.value = false;
  }
}

async function start(): Promise<void> {
  starting.value = true;
  review.value = null;
  try {
    const res = await roleplayApi.start(scenario.value, {
      ...(carModel.value.trim() ? { carModel: carModel.value.trim() } : {}),
      difficulty: difficulty.value,
    });
    sessionId.value = res.sessionId;
    turns.value = res.turns;
  } catch {
    ElMessage.error('AI 客户暂不可用，请稍后再试');
  } finally {
    starting.value = false;
  }
}

async function send(): Promise<void> {
  const message = input.value.trim();
  if (!message || busy.value || !sessionId.value) return;
  busy.value = true;
  turns.value.push({ role: 'staff', content: message });
  input.value = '';
  try {
    const res = await roleplayApi.turn(sessionId.value, message);
    turns.value = res.turns;
    if (res.mood) lastMood.value = res.mood;
  } catch {
    turns.value.push({ role: 'customer', content: '（AI 客户暂不可用，请稍后再试或结束本局）' });
  } finally {
    busy.value = false;
  }
}

async function finish(): Promise<void> {
  if (!sessionId.value || busy.value) return;
  busy.value = true;
  try {
    review.value = await roleplayApi.finish(sessionId.value, selfScore.value ?? undefined);
  } catch {
    ElMessage.error('点评暂不可用，请稍后再试');
  } finally {
    busy.value = false;
  }
}

function reset(): void {
  sessionId.value = '';
  turns.value = [];
  review.value = null;
  lastMood.value = null;
  selfScore.value = undefined;
}
</script>

<template>
  <div class="roleplay">
    <h2 class="wg-card-title">销售陪练<WgHintIcon k="roleplay.intro" /></h2>

    <!-- 开局配置卡 -->
    <div v-if="!sessionId && !review" class="wg-card roleplay__setup">
      <p class="roleplay__hint">
        AI
        扮演真实客户陪你练对话——选一个剧本开局，练完出教练点评。练出的好话术后续可沉淀为全店经验。
      </p>
      <div class="roleplay__form">
        <el-select v-model="scenario" placeholder="选择剧本">
          <el-option v-for="s in SCENARIOS" :key="s.value" :value="s.value" :label="s.label" />
        </el-select>
        <el-select v-model="difficulty" placeholder="客户难度">
          <el-option v-for="d in DIFFICULTIES" :key="d.value" :value="d.value" :label="d.label" />
        </el-select>
        <el-input v-model="carModel" placeholder="客户车型（可选，如 Model Y）" />
        <el-button type="primary" :loading="starting" @click="start">开局</el-button>
      </div>
    </div>

    <!-- 对话区 -->
    <div v-if="sessionId" class="wg-card roleplay__chat">
      <div class="roleplay__chat-head">
        <el-tag size="small">
          {{ SCENARIOS.find((s) => s.value === scenario)?.label }}
        </el-tag>
        <el-tag v-if="lastMood" size="small" type="info">{{ MOOD_LABEL[lastMood] }}</el-tag>
        <span class="roleplay__spacer" />
        <el-rate v-model="selfScore" size="small" title="练完自评" />
        <el-button size="small" :loading="busy" @click="finish">结束并点评</el-button>
      </div>
      <div class="roleplay__messages">
        <div
          v-for="(t, i) in turns"
          :key="i"
          class="roleplay-msg"
          :class="t.role === 'staff' ? 'roleplay-msg--staff' : 'roleplay-msg--customer'"
        >
          <div class="roleplay-msg__bubble">{{ t.content }}</div>
        </div>
      </div>
      <div class="roleplay__input">
        <el-input
          v-model="input"
          type="textarea"
          :rows="2"
          placeholder="你对客户说……（回车发送）"
          :disabled="busy || !!review"
          @keydown.enter.prevent="send"
        />
        <el-button type="primary" :loading="busy" :disabled="!input.trim()" @click="send">
          发送
        </el-button>
      </div>
    </div>

    <!-- 点评区 -->
    <div v-if="review" class="wg-card roleplay__review">
      <h3>教练点评</h3>
      <p class="roleplay__review-summary">{{ review.summary }}</p>
      <div v-if="review.strengths?.length">
        <h4>做得好的</h4>
        <p v-for="(s, i) in review.strengths" :key="i">• {{ s }}</p>
      </div>
      <div v-if="review.improvements?.length">
        <h4>可以改进</h4>
        <p v-for="(s, i) in review.improvements" :key="i">• {{ s }}</p>
      </div>
      <div v-if="review.demo" class="roleplay__demo">
        <h4>话术示范</h4>
        <p>{{ review.demo }}</p>
      </div>
      <el-divider />
      <div class="roleplay__extract">
        <el-button :loading="extracting" @click="extract(true)"
          >把这次的好回答提炼成经验卡</el-button
        >
        <p v-if="extractNote" class="roleplay__extract-note">{{ extractNote }}</p>
      </div>
      <el-button type="primary" @click="reset">再练一局</el-button>
    </div>

    <!-- 投喂真实聊天记录（批次6b）：成交/未成交的对话素材同样可提炼 -->
    <div class="wg-card roleplay__feed">
      <h3>投喂真实聊天记录</h3>
      <p class="roleplay__hint">
        粘贴你和客户的真实对话（每行一条，可写「客户：」「销售：」开头），AI 提炼成经验卡——
        老板审批后进全店经验库，助手和陪练都会引用。
      </p>
      <el-input
        v-model="feedText"
        type="textarea"
        :rows="5"
        placeholder="客户：你们贴膜多少钱？&#10;销售：看您什么车型，我先给您介绍下…"
      />
      <div class="roleplay__feed-actions">
        <el-button
          type="primary"
          :loading="feeding"
          :disabled="!feedText.trim()"
          @click="extract(false)"
        >
          提炼经验卡
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.roleplay__setup {
  max-width: 720px;
}
.roleplay__hint {
  margin: 0 0 12px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.roleplay__form {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.roleplay__form .el-select {
  width: 160px;
}
.roleplay__chat {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.roleplay__chat-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.roleplay__spacer {
  flex: 1;
}
.roleplay__messages {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 46vh;
  overflow-y: auto;
  padding: 4px;
}
.roleplay-msg {
  display: flex;
}
.roleplay-msg--staff {
  justify-content: flex-end;
}
.roleplay-msg__bubble {
  max-width: 72%;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--el-fill-color-light);
  white-space: pre-wrap;
  line-height: 1.6;
}
.roleplay-msg--staff .roleplay-msg__bubble {
  background: var(--el-color-primary-light-9);
}
.roleplay__input {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.roleplay__input .el-textarea {
  flex: 1;
}
.roleplay__review h3 {
  margin: 0 0 8px;
}
.roleplay__review h4 {
  margin: 10px 0 4px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.roleplay__review-summary {
  margin: 4px 0;
}
.roleplay__demo {
  margin-top: 10px;
  padding: 10px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}
.roleplay__extract {
  margin: 8px 0;
}
.roleplay__extract-note {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.roleplay__feed {
  margin-top: 12px;
  max-width: 720px;
}
.roleplay__feed h3 {
  margin: 0 0 4px;
}
.roleplay__feed-actions {
  margin-top: 8px;
}
</style>
