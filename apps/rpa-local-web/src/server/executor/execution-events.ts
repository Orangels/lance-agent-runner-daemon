import type { RpaExecutionEvent } from './execution-types.js';

export function serializeExecutionEvent(event: RpaExecutionEvent): string {
  return JSON.stringify(event);
}

export function parseExecutionEventLine(line: string): RpaExecutionEvent {
  return JSON.parse(line) as RpaExecutionEvent;
}

export function formatSseEvent(event: RpaExecutionEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function isTerminalExecutionEvent(event: RpaExecutionEvent): boolean {
  return event.type === 'run.completed';
}
