import { describe, expect, it } from 'vitest';
import { redactRpaText, redactRpaValue } from '../../../src/server/observability/rpa-redaction.js';

describe('RPA redaction', () => {
  it('redacts masked params', () => {
    const redacted = redactRpaText('case_no=A123', {
      storageRoot: '/tmp/rpa-local',
      maskedParamIds: ['case_no'],
      params: { case_no: 'A123' },
    });

    expect(redacted).toContain('[masked-param:case_no]');
    expect(redacted).not.toContain('A123');
  });

  it('does not globally replace short masked param values in free text', () => {
    const redacted = redactRpaText('step 1 selected option 12', {
      storageRoot: '/tmp/rpa-local',
      maskedParamIds: ['page'],
      params: { page: '1' },
    });

    expect(redacted).toBe('step 1 selected option 12');
    expect(redactRpaValue({ page: '1' }, {
      storageRoot: '/tmp/rpa-local',
      maskedParamIds: ['page'],
      params: { page: '1' },
    })).toEqual({ page: '[masked-param:page]' });
  });

  it('redacts phone numbers and identity-like values', () => {
    const redacted = redactRpaText('phone=13800138000 id=110101199003074219', {
      storageRoot: '/tmp/rpa-local',
      maskedParamIds: [],
      params: {},
    });

    expect(redacted).not.toContain('13800138000');
    expect(redacted).not.toContain('110101199003074219');
    expect(redacted).toContain('[redacted-phone]');
    expect(redacted).toContain('[redacted-id]');
  });

  it('redacts local storage paths', () => {
    const redacted = redactRpaText('path=/tmp/rpa-local/flow', {
      storageRoot: '/tmp/rpa-local',
      maskedParamIds: [],
      params: {},
    });

    expect(redacted).not.toContain('/tmp/rpa-local');
    expect(redacted).toContain('[rpa-storage]');
  });

  it('redacts nested feedback metadata', () => {
    const value = redactRpaValue(
      { stepId: 's1', params: { password: 'secret' }, message: '13800138000' },
      { storageRoot: '/tmp/rpa-local', maskedParamIds: ['password'], params: { password: 'secret' } },
    );

    expect(value).toEqual({
      stepId: 's1',
      params: { password: '[masked-param:password]' },
      message: '[redacted-phone]',
    });
  });
});
