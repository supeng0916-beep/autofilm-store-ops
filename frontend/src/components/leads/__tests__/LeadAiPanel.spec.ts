import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { describe, expect, it } from 'vitest';

import type { IntentProposal, LeadDetail } from '../../../api/leads';
import LeadAiPanel from '../LeadAiPanel.vue';

const PROPOSAL: IntentProposal = {
  taskId: 'task-1',
  level: 'high',
  confidence: 0.9,
  evidence: ['明确车型需求'],
  missingInfo: [],
  createdAt: '2026-08-28T01:00:00.000Z',
};

const LEAD: LeadDetail = {
  id: 'lead-1',
  intentLevel: 'high',
} as unknown as LeadDetail;

async function mountPanel() {
  const wrapper = mount(LeadAiPanel, {
    props: {
      summary: null,
      summaryStatus: 'done',
      lead: LEAD,
      proposal: PROPOSAL,
      proposalStatus: 'done',
      canEdit: true,
      regenSubmitting: false,
      classifySubmitting: false,
    },
    global: { plugins: [ElementPlus] },
  });
  await flushPromises();
  // 打开「改判」对话框
  const btn = wrapper.findAll('button').find((b) => b.text().includes('改判'));
  await btn?.trigger('click');
  await flushPromises();
  return wrapper;
}

describe('LeadAiPanel 改判理由必填（2026-08-28 P2）', () => {
  it('等级+理由齐全前确认按钮禁用；填齐后可提交并携带 reason', async () => {
    const wrapper = await mountPanel();
    const submit = wrapper.find('[data-testid="intent-override-submit"]');

    // 未选等级：禁用
    expect(submit.attributes('disabled')).toBeDefined();

    // 选等级但理由不足 2 字：仍禁用（此前只校验等级，缺理由可提交）
    await wrapper.findComponent({ name: 'ElSelect' }).vm.$emit('update:modelValue', 'low');
    await flushPromises();
    expect(submit.attributes('disabled')).toBeDefined();

    // 理由 ≥2 字：可提交
    await wrapper.find('[data-testid="intent-override-reason"]').setValue('客户明确说只是随便看看');
    await flushPromises();
    expect(submit.attributes('disabled')).toBeUndefined();

    await submit.trigger('click');
    await flushPromises();
    const emitted = wrapper.emitted('overrideIntent');
    expect(emitted).toHaveLength(1);
    expect(emitted![0]![0]).toEqual({ level: 'low', reason: '客户明确说只是随便看看' });
  });
});
