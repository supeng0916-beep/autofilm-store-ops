import { fetchAiTaskDetail, type AiTask } from './aiTasks';
import { http, TOKEN_KEY } from './http';

/** 对话历史项（前端多轮拼接，服务端截最近 8 轮） */
export interface AgentHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

/** 图片素材附件（done 富化后）：id 可直接走 assetApi 取鉴权文件流；
 * licensed=false 时卡片带「未授权」标记提醒（对外发送前人工确认） */
export interface AgentChatAsset {
  id: string;
  title: string;
  licensed?: boolean;
}

/** 技能输出契约（skill-sales-agent 同款，registry schema 校验兜底）；
 * reasoning（T2 决策留痕）：可选 ≤200 字决策说明，前端折叠展示「决策依据」 */
export interface AgentChatResult {
  reply: string;
  suggestions?: string[];
  assets?: AgentChatAsset[];
  reasoning?: string;
}

/** persona 映射条目（V1.5 管理端）：username/displayName 供 AiSettings 展示 */
export interface PersonaMapEntry {
  userId: string;
  persona: 'boss' | 'manager' | 'sales' | 'general';
  username: string;
  displayName: string;
}

/** 踩空提示（spec §7）：持 store_manager 多角色却无显式映射的账号（老板娘形态） */
export interface PersonaHint {
  userId: string;
  username: string;
  roles: string[];
}

/** 晨报手动触发结果（批次2）：已生成时返回既有内容 */
export interface MorningBriefResult {
  generated: boolean;
  date: string;
  content: string | null;
}

const TERMINAL_FAIL = new Set(['failed', 'timeout', 'degraded', 'cancelled']);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const agentApi = {
  /** 当前用户 persona（V1.5 分角色技能包）：抽屉标题显示"老板助手/店长助手/销售助手/门店助手" */
  persona: () =>
    http.get<{ persona: string; displayName: string }>('/agent/persona').then((r) => r.data),

  /** persona 映射全景（V1.5 管理，boss∪sys_admin）：entries + 踩空提示 */
  personaMap: () =>
    http
      .get<{ entries: PersonaMapEntry[]; unmappedMultiRole: PersonaHint[] }>('/agent/persona-map')
      .then((r) => r.data),

  /** persona 映射单条 set/del（persona=null 删除，映射回角色兜底） */
  setPersonaEntry: (userId: string, persona: string | null) =>
    http.put('/agent/persona-map', { userId, persona }).then((r) => r.data),

  /** 经营晨报手动触发（批次2，boss∪sys_admin）：幂等，已生成返回既有内容 */
  runMorningBrief: () =>
    http
      .post<MorningBriefResult>('/agent/morning-brief/run', {}, { timeout: 90_000 })
      .then((r) => r.data),

  /** 对话（POST /agent/chat）：登录即可，人格按角色服务端判定；
   * timeout 60s 对齐 AI 类请求专属超时先例（HANDOFF 踩坑实录） */
  chat: (message: string, history: AgentHistoryItem[]) =>
    http.post<AiTask>('/agent/chat', { message, history }, { timeout: 60_000 }).then((r) => r.data),

  /** 轮询任务至终态并提取输出（3s×20，AssetsView runSuggest 同模式） */
  pollUntilDone: async (taskId: string): Promise<AgentChatResult> => {
    let task = (await fetchAiTaskDetail(taskId)).task;
    let polls = 0;
    while (task.status !== 'done' && !TERMINAL_FAIL.has(task.status)) {
      if (polls >= 20) throw new Error('agent polling timeout');
      await sleep(3_000);
      polls += 1;
      task = (await fetchAiTaskDetail(taskId)).task;
    }
    if (task.status !== 'done') throw new Error(task.errorMessage ?? 'agent task failed');
    const out = task.output as {
      reply?: unknown;
      suggestions?: unknown;
      reasoning?: unknown;
    } | null;
    const reply = typeof out?.reply === 'string' ? out.reply : '';
    if (!reply) throw new Error('agent output missing reply');
    const suggestions = Array.isArray(out?.suggestions)
      ? out!.suggestions!.filter((s): s is string => typeof s === 'string')
      : [];
    const reasoning =
      typeof out?.reasoning === 'string' && out.reasoning ? out.reasoning : undefined;
    return reasoning ? { reply, suggestions, reasoning } : { reply, suggestions };
  },

  /** 流式对话（POST /agent/chat/stream，SSE over fetch——EventSource 不支持 POST/鉴权头）：
   * delta=增量回复文本（服务端已剥离 JSON 语法），done=权威终稿，error=降级离线口径。
   * 裸 fetch 不走 axios 拦截器：token 手动注入，失败不弹全局 toast（组件内降级气泡）。 */
  chatStream: async (
    message: string,
    history: AgentHistoryItem[],
    handlers: { onDelta?: (text: string) => void; signal?: AbortSignal } = {},
  ): Promise<AgentChatResult> => {
    const token = localStorage.getItem(TOKEN_KEY);
    const res = await fetch('/api/v1/agent/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ message, history }),
      signal: handlers.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`agent stream http ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: AgentChatResult | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf('\n\n');
      while (sep >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        sep = buffer.indexOf('\n\n');
        let event = 'message';
        let dataRaw = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataRaw += line.slice(5).trim();
        }
        if (!dataRaw) continue;
        const data = JSON.parse(dataRaw) as {
          text?: string;
          reply?: string;
          suggestions?: string[];
          assets?: AgentChatAsset[];
          reasoning?: string;
          message?: string;
        };
        if (event === 'delta' && typeof data.text === 'string') {
          handlers.onDelta?.(data.text);
        } else if (event === 'done' && typeof data.reply === 'string') {
          result = {
            reply: data.reply,
            suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
            ...(Array.isArray(data.assets) ? { assets: data.assets } : {}),
            ...(typeof data.reasoning === 'string' && data.reasoning
              ? { reasoning: data.reasoning }
              : {}),
          };
        } else if (event === 'error') {
          throw new Error(data.message ?? 'agent stream failed');
        }
      }
    }
    if (!result) throw new Error('agent stream ended without done');
    return result;
  },
};
