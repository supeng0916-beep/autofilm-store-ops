import { ElMessage } from 'element-plus';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetMessageUxForTest, setupMessageUx } from '../message-ux';

describe('message-ux：统一居中卡片形态（2026-08-27 弹窗统一）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    __resetMessageUxForTest();
  });

  it('包装后所有提示自动注入 showClose + wg-message 卡片样式 + 居中 offset', () => {
    const spy = vi.fn();
    vi.spyOn(ElMessage, 'error').mockImplementation(spy as never);
    setupMessageUx();
    (ElMessage.error as (o: unknown) => unknown)('该文件已导入过-唯一文案A');
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '该文件已导入过-唯一文案A',
        showClose: true,
        customClass: 'wg-message',
        offset: expect.any(Number),
      }),
    );
    // offset 为垂直居中基线（正数且明显大于默认顶部 16）
    const offset = spy.mock.calls[0][0].offset as number;
    expect(offset).toBeGreaterThan(100);
    // 调用方自定义参数保留合并
    (ElMessage.error as (o: unknown) => unknown)({ message: '唯一文案B', duration: 5000 });
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: '唯一文案B', duration: 5000, showClose: true }),
    );
    vi.restoreAllMocks();
  });

  it('同类型同文案在屏期间去重：第二次调用不再弹新卡片', () => {
    const spy = vi.fn();
    vi.spyOn(ElMessage, 'warning').mockImplementation(spy as never);
    setupMessageUx();
    const msg = () => (ElMessage.warning as (o: unknown) => unknown)('网络异常去重用例');
    msg();
    msg();
    msg();
    expect(spy).toHaveBeenCalledTimes(1);
    // 关闭后可再弹（onClose 由调用方/EP 触发时清表）
    const opts = spy.mock.calls[0][0] as { onClose?: () => void };
    opts.onClose?.();
    msg();
    expect(spy).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('不同文案不去重：各弹各的', () => {
    const spy = vi.fn();
    vi.spyOn(ElMessage, 'success').mockImplementation(spy as never);
    setupMessageUx();
    (ElMessage.success as (o: unknown) => unknown)('去重用例-甲');
    (ElMessage.success as (o: unknown) => unknown)('去重用例-乙');
    expect(spy).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('点击提示卡片非关闭区 → 关闭按钮收到 click（EP 自身逻辑接管关闭）', () => {
    const card = document.createElement('div');
    card.className = 'el-message';
    card.innerHTML = '<span>请勿重复提交</span><button class="el-message__closeBtn"></button>';
    document.body.appendChild(card);
    const btn = card.querySelector('.el-message__closeBtn')!;
    const btnClick = vi.fn();
    btn.addEventListener('click', btnClick);
    setupMessageUx();
    card.querySelector('span')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // 行为断言：点击卡片文本 → 关闭按钮确实收到 click（真实浏览器单次；happy-dom
    // 可能多次送达同storm，故只断言发生，不断言精确次数）
    expect(btnClick).toHaveBeenCalled();
  });
});
