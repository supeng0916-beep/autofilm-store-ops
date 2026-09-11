import { describe, expect, it } from 'vitest';
import {
  LEAD_STAGE,
  LEAD_FINAL_STATUS,
  LEAD_INTENT,
  LEAD_SILENCE_STAGE,
  LEAD_STAGE_TRANSITIONS,
  canTransitionStage,
} from '../src/modules/lead/lead.states';

describe('lead.states', () => {
  it('阶段合法迁移表覆盖全部六阶段且无自环', () => {
    expect(LEAD_STAGE_TRANSITIONS[LEAD_STAGE.NEW]).toContain(LEAD_STAGE.CONTACTED);
    expect(canTransitionStage('new', 'quoted')).toBe(false); // 不得跳级
    expect(canTransitionStage('visit_done', 'visit_done')).toBe(false);
  });
  it('三轴枚举值定稿', () => {
    expect(LEAD_FINAL_STATUS).toEqual({
      ACTIVE: 'active',
      SILENCE: 'silence',
      LOST_PENDING: 'lost_pending',
      LOST: 'lost',
      WON: 'won',
      INVALID: 'invalid',
    });
    expect(LEAD_INTENT).toEqual({ HIGH: 'high', MID: 'mid', LOW: 'low', PENDING: 'pending' });
    expect(LEAD_SILENCE_STAGE).toEqual({
      NONE: 'none',
      RISK: 'risk',
      FOLLOW_DUE: 'follow_due',
      NURTURE: 'nurture',
    });
  });
});
