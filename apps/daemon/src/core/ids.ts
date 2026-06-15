import { randomUUID } from 'node:crypto';

export type IdPrefix = 'ws' | 'run' | 'msg' | 'conv' | 'artifact' | 'feedback' | 'wh' | 'whd';

export function createId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}
