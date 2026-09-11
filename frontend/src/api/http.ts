import axios, { AxiosError } from 'axios';
import { ElMessage } from 'element-plus';

/** 后端统一错误响应结构（对应 backend/src/common/errors） */
export interface ApiErrorBody {
  code: string;
  message: string;
  detail?: unknown;
}

/** 按后端错误码分支的用户可读消息（P1-06 前端侧：前端按 code 分支处理） */
const CODE_MESSAGES: Record<string, string> = {
  UNAUTHORIZED: '未认证或登录已失效，请登录',
  AUTH_TOKEN_EXPIRED: '登录已过期，请重新登录',
  AUTH_TOKEN_INVALID: '登录状态无效，请重新登录',
  AUTH_INVALID_CREDENTIALS: '用户名或密码错误',
  AUTH_ACCOUNT_DISABLED: '账号已停用，请联系管理员',
  AUTH_ACCOUNT_LOCKED: '账号已锁定（连续失败过多），15 分钟后自动解锁',
  FORBIDDEN: '无权执行该操作',
  PERM_DENIED: '无权执行该操作',
  NOT_FOUND: '请求的资源不存在',
  VALIDATION_FAILED: '提交内容有误，请检查后重试',
  CONFLICT: '操作与当前状态冲突，请刷新后重试',
  APPROVAL_INVALID_STATE: '审批状态已变更，请刷新后重试',
  AI_DISABLED: 'AI 通道暂不可用，请人工处理',
  AI_BUDGET_EXCEEDED: 'AI 当日预算已用尽，已暂停新任务',
  AI_TASK_INVALID_STATE: 'AI 任务状态已变化，请刷新后重试',
  AI_SIGNATURE_INVALID: 'AI 回调签名校验失败',
  LEAD_INVALID_STATE: '客资状态已变化，请刷新后重试',
  LEAD_PARSE_FAILED: '导入内容解析失败，请检查格式',
  LEAD_DUP_BATCH: '该文件已导入过，请勿重复提交',
  LEAD_NOT_OWNER: '只能操作本人负责的客资',
};

/** Zod v4 原始报错 → 中文（2026-08-28 UI 测试 #6：2000 字跟进提交 toast 显示
 * 英文原始错误）。字段级自定义消息（DTO 里写的中文）不含这些前缀，原样保留。 */
const ZOD_TEXT_MAP: Array<[RegExp, string]> = [
  // 正则一律吞整句（.*$），replace 后不留英文残尾
  [/^too big: expected string to have <=(\d+) characters?.*$/i, '内容超出长度上限（最多 $1 字）'],
  [/^too small: expected string to have >=(\d+) characters?.*$/i, '内容不足最小长度（至少 $1 字）'],
  [/^invalid input: expected string, received.*$/i, '该项格式有误，需为文本'],
  [/^invalid input:.*$/i, '该项格式有误'],
  [/^input length too long.*$/i, '内容超出长度上限'],
  [/^validation failed$/i, '提交内容有误，请检查后重试'],
];

function toChineseValidationText(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  for (const [re, zh] of ZOD_TEXT_MAP) {
    if (re.test(t)) return t.replace(re, zh);
  }
  return null;
}

/** 从 400 detail 里提取 zod 校验消息（nestjs-zod 包一层 {error: ZodError}）。
 * 优先取自定义中文消息（含 CJK 的 issue 最具体）；全英文则映射为中文长度/格式提示；
 * 提取不到返回 null（调用方回退通用文案）。 */
function extractValidationMessage(detail: unknown): string | null {
  if (!detail || typeof detail !== 'object') return null;
  const d = detail as Record<string, unknown>;
  const sources: unknown[] = [d.error, d.errors, d.message];
  const messages: string[] = [];
  for (const src of sources) {
    if (typeof src === 'string') messages.push(src);
    else if (Array.isArray(src)) {
      for (const item of src) {
        if (typeof item === 'string') messages.push(item);
        else if (item && typeof item === 'object') {
          const m = (item as Record<string, unknown>).message;
          if (typeof m === 'string') messages.push(m);
        }
      }
    } else if (src && typeof src === 'object') {
      const issues = (src as Record<string, unknown>).issues;
      if (Array.isArray(issues)) {
        for (const issue of issues) {
          const m =
            issue && typeof issue === 'object' ? (issue as Record<string, unknown>).message : null;
          if (typeof m === 'string') messages.push(m);
        }
      }
    }
  }
  const chinese = messages.find((m) => /[\u4e00-\u9fff]/.test(m) && !toChineseValidationText(m));
  if (chinese) return chinese;
  for (const m of messages) {
    const zh = toChineseValidationText(m);
    if (zh) return zh;
  }
  return null;
}

/** 把任意错误归一化为用户可读消息（纯函数，便于测试）。
 * 优先级：已知错误码分支文案（VALIDATION_FAILED 先尝试字段级明细）> 后端 body.message
 * （英文校验错误映射中文）> 网络错误提示 > 状态码提示。 */
export function toApiMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const body = (error as AxiosError<ApiErrorBody>).response?.data;
    if (body?.code === 'VALIDATION_FAILED') {
      const specific = extractValidationMessage(body.detail);
      if (specific) return specific;
    }
    if (body?.code && CODE_MESSAGES[body.code]) return CODE_MESSAGES[body.code];
    if (body?.message) {
      const zh = toChineseValidationText(body.message);
      return zh ?? body.message;
    }
    if (error.code === 'ERR_NETWORK') return '网络异常，请检查连接';
    return `请求失败（${error.response?.status ?? '未知状态'}）`;
  }
  return '未知错误，请重试';
}

/** 判断是否为登录请求（P2 终审 triage 加固）：仅按路径精确匹配登录端点。
 * 剥离 query/hash 后取 pathname 精确比较，杜绝 endsWith 对带查询串/相似路径的误判；
 * 同时兼容调用方相对路径 '/auth/login' 与全路径 '/api/v1/auth/login' 两种写法。 */
export function isLoginRequest(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split(/[?#]/)[0];
  return path === '/auth/login' || path === '/api/v1/auth/login';
}

/** 全局 axios 实例：统一 baseURL、超时与错误提示 */
export const http = axios.create({
  baseURL: '/api/v1',
  timeout: 15000,
});

export const TOKEN_KEY = 'wg.accessToken';
const REFRESH_KEY = 'wg.refreshToken';

/** 单飞续期（2026-08-21 修复「15 分钟令牌过期后被静默登出」）：并发 401 只发一次
 * /auth/refresh；用裸 axios 防拦截器递归；成功回写两个令牌，失败返回 null。 */
let refreshing: Promise<string | null> | null = null;

function tryRefresh(): Promise<string | null> {
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return Promise.resolve(null);
  refreshing ??= axios
    .post<{ accessToken: string; refreshToken: string }>('/api/v1/auth/refresh', {
      refreshToken,
    })
    .then((res) => {
      localStorage.setItem(TOKEN_KEY, res.data.accessToken);
      localStorage.setItem(REFRESH_KEY, res.data.refreshToken);
      return res.data.accessToken;
    })
    .catch(() => null)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

// 请求拦截器：注入 Bearer token。直接读 localStorage 而非 stores/auth，避免循环依赖
http.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

http.interceptors.response.use(
  (resp) => resp,
  async (error: unknown) => {
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 401 &&
      !isLoginRequest(error.config?.url)
    ) {
      // 登录请求的 401（账号密码错误等）豁免：用户本就在登录页，整页刷新会清掉错误提示与已输入内容。
      // 其余 401：先尝试静默续期并重试一次（访问令牌 15 分钟到期是常态，不应把人踢回登录页）；
      // 续期失败或重试仍 401 才清登录态跳转（懒加载 import 引 store，避免循环依赖；
      // assign('/login') 整页刷新，store 状态随之清空；仍 reject 让调用方 catch）。
      const config = error.config;
      const refreshed = await tryRefresh();
      if (
        refreshed &&
        config &&
        !(config as { __retriedAfterRefresh?: boolean }).__retriedAfterRefresh
      ) {
        (config as { __retriedAfterRefresh?: boolean }).__retriedAfterRefresh = true;
        return http.request(config); // 重走请求拦截器（新令牌已落 localStorage），成功则静默返回
      }
      const { useAuthStore } = await import('../stores/auth');
      useAuthStore().logout();
      window.location.assign('/login');
    }
    // 登录请求的报错不弹全局 toast（2026-08-22 修复双重提示）：登录页已用同款
    // 极简居中弹窗呈现完整信息（剩余次数/锁定说明），toast 会叠在弹窗之上
    if (
      axios.isAxiosError(error) &&
      !isLoginRequest((error as { config?: { url?: string } }).config?.url)
    ) {
      ElMessage.error(toApiMessage(error));
    }
    return Promise.reject(error);
  },
);
