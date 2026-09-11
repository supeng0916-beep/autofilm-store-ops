import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { http, isLoginRequest, toApiMessage } from '../http';

// 部分 mock element-plus：ElMessage 不真实渲染，只记录调用（与 ApprovalCenterView.spec 同款模式）
const message = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('element-plus')>();
  return { ...actual, ElMessage: message };
});

// 构造 axios 错误（绕过类型约束，测试只关心运行时行为）
function axiosError(status: number | undefined, data: unknown, code?: string): AxiosError {
  const err = new AxiosError('request failed', code);
  if (status !== undefined) {
    Object.assign(err, {
      response: { status, data, statusText: '', headers: {}, config: {} },
    });
  }
  return err;
}

/** CODE_MESSAGES 关键键 → 期望文案（与 http.ts 分支映射对齐，P1 Task 9） */
const CODE_CASES: Array<[string, string, number]> = [
  ['UNAUTHORIZED', '未认证或登录已失效，请登录', 401],
  ['AUTH_TOKEN_EXPIRED', '登录已过期，请重新登录', 401],
  ['PERM_DENIED', '无权执行该操作', 403],
  ['VALIDATION_FAILED', '提交内容有误，请检查后重试', 400],
  ['CONFLICT', '操作与当前状态冲突，请刷新后重试', 409],
  ['NOT_FOUND', '请求的资源不存在', 404],
  ['AI_DISABLED', 'AI 通道暂不可用，请人工处理', 503],
  ['AI_BUDGET_EXCEEDED', 'AI 当日预算已用尽，已暂停新任务', 429],
  ['AI_TASK_INVALID_STATE', 'AI 任务状态已变化，请刷新后重试', 409],
  ['AI_SIGNATURE_INVALID', 'AI 回调签名校验失败', 401],
];

describe('toApiMessage 错误归一化', () => {
  it.each(CODE_CASES)('已知错误码 %s 按 CODE_MESSAGES 分支映射', (apiCode, expected, status) => {
    const err = axiosError(status, { code: apiCode, message: '后端原始消息（不应透出）' });
    expect(toApiMessage(err)).toBe(expected);
  });

  it('已知错误码优先于 body.message', () => {
    const err = axiosError(404, { code: 'NOT_FOUND', message: '客资不存在' });
    expect(toApiMessage(err)).toBe('请求的资源不存在');
  });

  it('未知错误码回退后端结构化错误消息', () => {
    const err = axiosError(400, { code: 'SOME_UNKNOWN_CODE', message: '客资不存在' });
    expect(toApiMessage(err)).toBe('客资不存在');
  });

  it('无 code 但有 message 时回退 body.message', () => {
    const err = axiosError(500, { message: '服务暂时不可用' });
    expect(toApiMessage(err)).toBe('服务暂时不可用');
  });

  it('无结构化消息时给出状态码提示', () => {
    const err = axiosError(500, undefined);
    expect(toApiMessage(err)).toContain('500');
  });

  it('网络错误给出可读提示', () => {
    const err = axiosError(undefined, undefined, 'ERR_NETWORK');
    expect(toApiMessage(err)).toContain('网络异常');
  });

  it('非 axios 错误回退为通用提示', () => {
    expect(toApiMessage(new Error('x'))).toBe('未知错误，请重试');
  });

  // —— 2026-08-28 UI 测试 #6：长度类 400 原始英文报错 → 中文（字段级明细优先） ——
  it('VALIDATION_FAILED 优先透出 detail 里的字段级中文校验消息', () => {
    const err = axiosError(400, {
      code: 'VALIDATION_FAILED',
      message: '入参校验失败',
      detail: {
        statusCode: 400,
        message: 'Validation failed',
        error: {
          issues: [
            {
              code: 'too_big',
              message: 'Too big: expected string to have <=2000 characters',
              path: ['result'],
            },
            { code: 'invalid_type', message: '跟进结果必填', path: ['result'] },
          ],
        },
      },
    });
    expect(toApiMessage(err)).toBe('跟进结果必填');
  });

  it('VALIDATION_FAILED 全英文 Zod 消息映射为中文长度提示', () => {
    const err = axiosError(400, {
      code: 'VALIDATION_FAILED',
      message: '入参校验失败',
      detail: {
        error: {
          issues: [
            { code: 'too_big', message: 'Too big: expected string to have <=2000 characters' },
          ],
        },
      },
    });
    expect(toApiMessage(err)).toBe('内容超出长度上限（最多 2000 字）');
  });

  it('VALIDATION_FAILED 无可提取明细时回退通用文案', () => {
    const err = axiosError(400, { code: 'VALIDATION_FAILED', message: '入参校验失败' });
    expect(toApiMessage(err)).toBe('提交内容有误，请检查后重试');
  });

  it('未知错误码的英文 body.message 同样映射为中文（input length too long 实测形态）', () => {
    const err = axiosError(400, { code: 'SOME_CODE', message: 'input length too long' });
    expect(toApiMessage(err)).toBe('内容超出长度上限');
  });

  it('类型不匹配的 Zod 英文消息映射为格式提示', () => {
    const err = axiosError(400, {
      code: 'VALIDATION_FAILED',
      detail: {
        error: { issues: [{ message: 'Invalid input: expected string, received undefined' }] },
      },
    });
    expect(toApiMessage(err)).toBe('该项格式有误，需为文本');
  });
});

describe('isLoginRequest 登录请求判定（P2 终审 triage 加固）', () => {
  it.each(['/auth/login', '/api/v1/auth/login'])('%s 判定为登录请求', (url) => {
    expect(isLoginRequest(url)).toBe(true);
  });

  it('剥离 query/hash 后按路径精确匹配：带查询串/锚点的登录路径仍判定为登录请求', () => {
    expect(isLoginRequest('/api/v1/auth/login?redirect=/dashboard')).toBe(true);
    expect(isLoginRequest('/api/v1/auth/login#top')).toBe(true);
    expect(isLoginRequest('/auth/login?x=1')).toBe(true);
  });

  it('非登录路径（相似后缀/尾斜杠/查询串伪装）判定为 false', () => {
    expect(isLoginRequest('/api/v1/auth/refresh')).toBe(false);
    expect(isLoginRequest('/api/v1/auth/loginx')).toBe(false);
    expect(isLoginRequest('/api/v1/auth/login/')).toBe(false);
    expect(isLoginRequest('/api/v1/other?next=/auth/login')).toBe(false);
    expect(isLoginRequest(undefined)).toBe(false);
  });
});

/** 自定义 adapter：直接 reject 一个 401 AxiosError（config 由 axios 注入，url 为调用方原始路径） */
function adapter401(data: unknown) {
  return (config: InternalAxiosRequestConfig) =>
    Promise.reject(
      new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', config, undefined, {
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        data,
        config,
      }),
    );
}

describe('响应拦截器 401 处理', () => {
  let assignSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActivePinia(createPinia());
    message.error.mockClear();
    // happy-dom 下替换 assign 避免真实导航，同时用于断言是否触发跳转
    assignSpy = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
  });

  afterEach(() => {
    http.defaults.adapter = undefined;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('登录请求（/auth/login）的 401 豁免整页跳转，也不弹全局 toast（登录页自有弹窗）', async () => {
    http.defaults.adapter = adapter401({
      code: 'AUTH_INVALID_CREDENTIALS',
      message: '用户名或密码错误',
    });
    await expect(http.post('/auth/login', { username: 'a', password: 'b' })).rejects.toBeDefined();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(message.error).not.toHaveBeenCalled();
  });

  it('非登录请求的 401 清登录态并跳转 /login', async () => {
    localStorage.setItem('wg.accessToken', 'expired-token');
    http.defaults.adapter = adapter401({ code: 'AUTH_TOKEN_EXPIRED', message: 'expired' });
    await expect(http.get('/auth/me')).rejects.toBeDefined();
    expect(assignSpy).toHaveBeenCalledWith('/login');
    expect(localStorage.getItem('wg.accessToken')).toBeNull();
    expect(message.error).toHaveBeenCalledWith('登录已过期，请重新登录');
  });

  it('401 且持有效续期令牌：静默续期并重试成功，不登出不弹错（2026-08-21）', async () => {
    localStorage.setItem('wg.accessToken', 'expired-token');
    localStorage.setItem('wg.refreshToken', 'rt-ok');
    const postSpy = vi
      .spyOn(axios, 'post')
      .mockResolvedValue({ data: { accessToken: 'new-token', refreshToken: 'new-rt' } });
    let call = 0;
    http.defaults.adapter = (config: InternalAxiosRequestConfig) => {
      call += 1;
      if (call === 1) {
        return Promise.reject(
          new AxiosError('401', 'ERR_BAD_REQUEST', config, undefined, {
            status: 401,
            statusText: 'Unauthorized',
            headers: {},
            data: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' },
            config,
          }),
        );
      }
      return Promise.resolve({
        data: { ok: 1 },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      } as unknown as AxiosResponse);
    };
    const res = await http.get('/auth/me');
    expect(res.data).toEqual({ ok: 1 });
    expect(postSpy).toHaveBeenCalledWith('/api/v1/auth/refresh', { refreshToken: 'rt-ok' });
    expect(localStorage.getItem('wg.accessToken')).toBe('new-token');
    expect(localStorage.getItem('wg.refreshToken')).toBe('new-rt');
    expect(assignSpy).not.toHaveBeenCalled();
    expect(message.error).not.toHaveBeenCalled();
  });

  it('401 且续期失败：登出并跳转 /login', async () => {
    localStorage.setItem('wg.accessToken', 'expired-token');
    localStorage.setItem('wg.refreshToken', 'rt-bad');
    vi.spyOn(axios, 'post').mockRejectedValue(new Error('refresh failed'));
    http.defaults.adapter = adapter401({ code: 'AUTH_TOKEN_EXPIRED', message: 'expired' });
    await expect(http.get('/auth/me')).rejects.toBeDefined();
    expect(assignSpy).toHaveBeenCalledWith('/login');
    expect(localStorage.getItem('wg.accessToken')).toBeNull();
  });
});
