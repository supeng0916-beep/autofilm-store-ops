<script setup lang="ts">
/* global AbortController, URL, window */
// AI 助手对话抽屉（2026-08-26 销售 Agent V1）：顶栏常驻入口，按角色装载技能包
// （人格在后端判定，组件无感知）。多轮=组件内存拼接最近 8 轮（刷新即清，spec §4 存储最小化）；
// 同日流式迭代：回复经 SSE 增量渲染（delta 逐段上屏，done 权威终稿替换）；
// 失败降级为离线气泡不重试轰炸；输出为建议态，复制动作由人工触发。
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';

import { Picture } from '@element-plus/icons-vue';

import { assetApi } from '../../api/asset';
import { agentApi, type AgentChatAsset, type AgentHistoryItem } from '../../api/agent';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
});

/** 抽屉标题（V1.5 分角色技能包）：按当前用户 persona 显示专属包名；
 * 拉取失败保持默认「AI 助手」，不阻塞对话（服务端路由不依赖前端标题） */
const title = ref('AI 助手');
onMounted(async () => {
  try {
    title.value = (await agentApi.persona()).displayName;
  } catch {
    /* 降级保持默认标题 */
  }
});

interface Msg extends AgentHistoryItem {
  suggestions?: string[];
  error?: boolean;
  /** 流式中：true=正在逐段上屏（done/error 落定后清除） */
  streaming?: boolean;
  /** 报价图附件（done 富化）：点击可放大预览 */
  assets?: AgentChatAsset[];
  /** 决策依据（T2 决策留痕）：done 携带 reasoning 才有，默认收起点击展开 */
  reasoning?: string;
  reasoningOpen?: boolean;
}

const messages = ref<Msg[]>([]);
const input = ref('');
const sending = ref(false);
/** 取消标志：卸载后回调静默退出（AssetsView suggestCancelled 同模式） */
let cancelled = false;
let activeAbort: AbortController | null = null;
/** 附件 blob URL 缓存（id → thumb/full），卸载时统一释放 */
const assetThumbUrls = ref<Record<string, string>>({});
const assetFullUrls = ref<Record<string, string>>({});
onUnmounted(() => {
  cancelled = true;
  activeAbort?.abort();
  for (const map of [assetThumbUrls.value, assetFullUrls.value]) {
    for (const url of Object.values(map)) URL.revokeObjectURL(url);
  }
});

/** 附件缩略图按需加载（带令牌 blob，AssetsView 同模式；失败静默降级为文字卡片） */
async function ensureAssetThumbs(assets: AgentChatAsset[]): Promise<void> {
  await Promise.all(
    assets
      .filter((a) => !assetThumbUrls.value[a.id])
      .map(async (a) => {
        try {
          assetThumbUrls.value[a.id] = URL.createObjectURL(await assetApi.fetchThumb(a.id));
        } catch {
          // 缩略失败保留文字卡片（无图），不阻断对话
        }
      }),
  );
}

/** 点击附件：预览全图（首次取文件流，之后走缓存） */
async function openAssetPreview(a: AgentChatAsset): Promise<void> {
  if (!assetFullUrls.value[a.id]) {
    try {
      assetFullUrls.value[a.id] = URL.createObjectURL(await assetApi.fetchFile(a.id));
    } catch {
      return; // http 拦截器已 toast
    }
  }
  window.open(assetFullUrls.value[a.id], '_blank');
}

async function send(): Promise<void> {
  const text = input.value.trim();
  if (!text || sending.value) return;
  sending.value = true;
  const history = messages.value
    .filter((m) => !m.error)
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content }));
  messages.value.push({ role: 'user', content: text });
  input.value = '';
  // reactive 包装：delta 高频直接改原始对象不触发视图，须持代理引用
  const entry = reactive<Msg>({ role: 'assistant', content: '', streaming: true });
  messages.value.push(entry);
  activeAbort = new AbortController();
  try {
    const result = await agentApi.chatStream(text, history, {
      onDelta: (chunk) => {
        entry.content += chunk;
      },
      signal: activeAbort.signal,
    });
    if (cancelled) return;
    entry.content = result.reply;
    entry.streaming = false;
    if (result.suggestions?.length) entry.suggestions = result.suggestions;
    if (result.reasoning) entry.reasoning = result.reasoning;
    if (result.assets?.length) {
      entry.assets = result.assets;
      void ensureAssetThumbs(result.assets);
    }
  } catch {
    if (cancelled) return;
    entry.content = 'AI 暂时离线，请稍后再试';
    entry.error = true;
    entry.streaming = false;
    input.value = text; // 失败保留输入可重试（裸 fetch 无拦截器 toast，靠离线气泡提示）
  } finally {
    sending.value = false;
    activeAbort = null;
  }
}

function applySuggestion(s: string): void {
  input.value = s;
}
</script>

<template>
  <el-drawer v-model="visible" :title="title" size="420px" append-to-body>
    <div class="agent-chat">
      <div class="agent-chat__messages">
        <el-empty
          v-if="messages.length === 0"
          description="随时问：话术起草 / 报价口径 / 店知识 / 短视频文案"
        />
        <div
          v-for="(m, i) in messages"
          :key="i"
          class="agent-msg"
          :class="m.role === 'user' ? 'agent-msg--user' : 'agent-msg--assistant'"
        >
          <div
            class="agent-msg__bubble"
            :class="{
              'agent-msg__bubble--error': m.error,
              'agent-msg__bubble--streaming': m.streaming,
            }"
          >
            {{ m.streaming && !m.content ? '思考中…' : m.content }}
          </div>
          <div v-if="m.assets?.length" class="agent-msg__assets">
            <button
              v-for="a in m.assets"
              :key="a.id"
              type="button"
              class="agent-asset"
              data-testid="agent-asset"
              :title="a.title"
              @click="openAssetPreview(a)"
            >
              <img v-if="assetThumbUrls[a.id]" :src="assetThumbUrls[a.id]" :alt="a.title" />
              <el-icon v-else :size="28"><Picture /></el-icon>
              <span class="agent-asset__title">{{ a.title }}</span>
              <span v-if="a.licensed === false" class="agent-asset__unlicensed">未授权</span>
            </button>
          </div>
          <div v-if="m.reasoning" class="agent-msg__reasoning">
            <button
              type="button"
              class="agent-msg__reasoning-toggle"
              data-testid="agent-reasoning-toggle"
              @click="m.reasoningOpen = !m.reasoningOpen"
            >
              {{ m.reasoningOpen ? '▾' : '▸' }} 决策依据
            </button>
            <p
              v-if="m.reasoningOpen"
              class="agent-msg__reasoning-body"
              data-testid="agent-reasoning-body"
            >
              {{ m.reasoning }}
            </p>
          </div>
          <div v-if="m.suggestions?.length" class="agent-msg__suggestions">
            <span class="agent-msg__suggestions-label">接着问：</span>
            <el-button
              v-for="s in m.suggestions"
              :key="s"
              size="small"
              text
              type="primary"
              class="agent-msg__suggestion"
              data-testid="agent-suggestion"
              @click="applySuggestion(s)"
              >{{ s }}</el-button
            >
          </div>
        </div>
        <div
          v-if="sending && !messages.some((m) => m.streaming)"
          class="agent-msg agent-msg--assistant"
        >
          <div class="agent-msg__bubble agent-msg__bubble--pending">思考中…</div>
        </div>
      </div>
      <div class="agent-chat__composer">
        <el-input
          v-model="input"
          type="textarea"
          :rows="2"
          maxlength="2000"
          placeholder="输入问题，回车发送"
          data-testid="agent-input"
          @keyup.enter.prevent="send"
        />
        <el-button
          type="primary"
          :loading="sending"
          :disabled="!input.trim()"
          data-testid="agent-send"
          @click="send"
          >发送</el-button
        >
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
.agent-chat {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.agent-chat__messages {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-right: 4px;
}
.agent-msg {
  display: flex;
  flex-direction: column;
}
.agent-msg--user {
  align-items: flex-end;
}
.agent-msg--assistant {
  align-items: flex-start;
}
.agent-msg__bubble {
  max-width: 86%;
  padding: 8px 12px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
  /* 2026-08-26 老板反馈排版拥挤：技能侧按纯文本换行分段输出，pre-wrap 让换行生效 */
  white-space: pre-wrap;
  background: var(--el-fill-color-light);
}
.agent-msg--user .agent-msg__bubble {
  background: var(--el-color-primary-light-9);
}
.agent-msg__bubble--error {
  color: var(--el-color-danger);
}
.agent-msg__bubble--pending {
  color: var(--el-text-color-secondary);
}
/* 流式光标：逐段上屏时尾部闪烁，落定后随 streaming 清除 */
.agent-msg__bubble--streaming::after {
  content: '▍';
  margin-left: 1px;
  color: var(--el-color-primary);
  animation: agent-cursor-blink 1s steps(1) infinite;
}
@keyframes agent-cursor-blink {
  50% {
    opacity: 0;
  }
}
.agent-msg__suggestions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.agent-msg__suggestions-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.agent-msg__suggestion {
  padding: 2px 6px;
}
/* 决策依据折叠（T2 决策留痕）：默认收起一行入口，点开显示 reasoning 原文 */
.agent-msg__reasoning {
  margin-top: 6px;
  max-width: 86%;
}
.agent-msg__reasoning-toggle {
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.agent-msg__reasoning-toggle:hover {
  color: var(--el-color-primary);
}
.agent-msg__reasoning-body {
  margin: 4px 0 0;
  padding: 6px 10px;
  border-left: 2px solid var(--el-border-color);
  border-radius: 0 8px 8px 0;
  background: var(--el-fill-color-lighter);
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  white-space: pre-wrap;
  word-break: break-word;
}
/* 报价图附件卡片：缩略图 + 标题，点击新窗口打开原图 */
.agent-msg__assets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
  max-width: 86%;
}
.agent-asset {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 6px 6px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 10px;
  background: var(--el-bg-color);
  cursor: pointer;
  max-width: 100%;
}
.agent-asset:hover {
  border-color: var(--el-color-primary);
}
.agent-asset img {
  width: 44px;
  height: 44px;
  object-fit: cover;
  border-radius: 6px;
  flex-shrink: 0;
}
.agent-asset__title {
  font-size: 12px;
  color: var(--el-text-color-regular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-asset__unlicensed {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 4px;
  color: var(--el-color-warning);
  background: color-mix(in srgb, var(--el-color-warning) 14%, transparent);
}
.agent-chat__composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin-top: 12px;
}
.agent-chat__composer :deep(.el-textarea) {
  flex: 1;
}
</style>
