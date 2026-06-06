import { createHash } from 'node:crypto';
import type { CollectionMode } from './run-types.js';

export interface TextSnapshot {
  hash: string;
  charCount: number;
  byteCount: number;
}

export function createTextSnapshot(value: string): TextSnapshot {
  return {
    hash: sha256(value),
    charCount: Array.from(value).length,
    byteCount: Buffer.byteLength(value, 'utf8'),
  };
}

export function shouldPersistFullSnapshot(collectionMode: CollectionMode): boolean {
  return collectionMode !== 'lite';
}

export function stableJsonStringify(value: unknown, space?: number): string {
  return JSON.stringify(sortJson(value), null, space);
}

export function stableJsonHash(value: unknown): string {
  return sha256(stableJsonStringify(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, innerValue]) => [key, sortJson(innerValue)]),
  );
}
