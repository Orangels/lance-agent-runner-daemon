import type { RpaExecutionEvent } from './execution-types.js';

export function formatSseEvent(event: RpaExecutionEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function isTerminalExecutionEvent(event: RpaExecutionEvent): boolean {
  return event.type === 'run.completed';
}
