import { randomUUID } from 'node:crypto';

export type IdPrefix = 'ws' | 'run' | 'msg' | 'conv' | 'artifact' | 'feedback';

export function createId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}
