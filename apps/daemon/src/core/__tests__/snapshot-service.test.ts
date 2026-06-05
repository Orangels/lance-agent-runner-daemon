import { describe, expect, it } from 'vitest';
import {
  createTextSnapshot,
  shouldPersistFullSnapshot,
  stableJsonHash,
} from '../snapshot-service.js';

describe('snapshot service', () => {
  it('hashes text and counts chars and bytes', () => {
    const snapshot = createTextSnapshot('abc公安');

    expect(snapshot.charCount).toBe(5);
    expect(snapshot.byteCount).toBe(Buffer.byteLength('abc公安', 'utf8'));
    expect(snapshot.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('persists full snapshots only outside lite mode', () => {
    expect(shouldPersistFullSnapshot('lite')).toBe(false);
    expect(shouldPersistFullSnapshot('diagnostic')).toBe(true);
    expect(shouldPersistFullSnapshot('review')).toBe(true);
  });

  it('hashes JSON stably', () => {
    expect(stableJsonHash({ b: 2, a: 1 })).toBe(stableJsonHash({ a: 1, b: 2 }));
  });
});
