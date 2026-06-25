import { describe, expect, it } from 'vitest';
import {
  formatRunEventId,
  parseRunEventId,
  shouldReplayEventAfter,
} from '../../src/core/run-events.js';

describe('run event id helpers', () => {
  it('parses and formats numeric event ids for SSE replay', () => {
    expect(parseRunEventId('42')).toBe(42);
    expect(parseRunEventId(' 42 ')).toBe(42);
    expect(parseRunEventId('0')).toBe(0);
    expect(parseRunEventId('')).toBeNull();
    expect(parseRunEventId('1.5')).toBeNull();
    expect(parseRunEventId('-1')).toBeNull();
    expect(parseRunEventId('abc')).toBeNull();
    expect(formatRunEventId(42)).toBe('42');
  });

  it('checks event ids numerically for Last-Event-ID and after replay', () => {
    expect(shouldReplayEventAfter('10', '9')).toBe(true);
    expect(shouldReplayEventAfter('9', '10')).toBe(false);
  });
});
