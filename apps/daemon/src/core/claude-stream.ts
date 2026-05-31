import { capRawEventLine, type RunEventSink } from './run-events.js';

/**
 * Parses Claude Code's `--output-format stream-json --verbose` JSONL stream
 * into daemon run events. The parser supports streamed partial messages and
 * final-wrapper fallback output from older Claude Code builds.
 */

type BlockState = { type?: unknown; name?: unknown; id?: unknown; input: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function createClaudeStreamHandler(onEvent: RunEventSink) {
  let buffer = '';

  // Per-content-block scratch, keyed by `${messageId}:${blockIndex}`.
  const blocks = new Map<string, BlockState>();
  // Tool uses already emitted from either streamed input or final wrappers.
  const emittedToolUseIds = new Set<string>();
  // Most recent assistant message id for content_block_* events without ids.
  let currentMessageId: string | null = null;
  // Message ids that already streamed text via `stream_event` deltas.
  const textStreamed = new Set<string>();

  function blockKey(index: unknown): string {
    return `${currentMessageId ?? 'anon'}:${index}`;
  }

  function feed(chunk: string) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        onEvent({ type: 'raw', line: capRawEventLine(line) });
        continue;
      }
      handleObject(obj);
    }
  }

  function flush() {
    const rem = buffer.trim();
    buffer = '';
    if (!rem) return;
    try {
      handleObject(JSON.parse(rem));
    } catch {
      onEvent({ type: 'raw', line: capRawEventLine(rem) });
    }
  }

  function handleObject(obj: unknown) {
    if (!isRecord(obj)) return;

    if (obj.type === 'system' && obj.subtype === 'init') {
      onEvent({
        type: 'status',
        label: 'initializing',
        model: obj.model ?? null,
        sessionId: obj.session_id ?? null,
      });
      return;
    }

    if (obj.type === 'system' && obj.subtype === 'status') {
      onEvent({ type: 'status', label: String(obj.status ?? 'working') });
      return;
    }

    if (obj.type === 'stream_event' && isRecord(obj.event)) {
      handleStreamEvent(obj.event);
      return;
    }

    if (obj.type === 'assistant' && isRecord(obj.message) && Array.isArray(obj.message.content)) {
      currentMessageId = typeof obj.message.id === 'string' ? obj.message.id : currentMessageId;
      const msgId = typeof obj.message.id === 'string' ? obj.message.id : null;
      const alreadyStreamed = msgId ? textStreamed.has(msgId) : false;
      for (const block of obj.message.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'tool_use') {
          emitToolUseOnce(block.id, block.name, block.input ?? null);
        } else if (
          !alreadyStreamed &&
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.length > 0
        ) {
          onEvent({ type: 'text_delta', delta: block.text });
        } else if (
          !alreadyStreamed &&
          block.type === 'thinking' &&
          typeof block.thinking === 'string' &&
          block.thinking.length > 0
        ) {
          onEvent({ type: 'thinking_delta', delta: block.thinking });
        }
      }
      return;
    }

    if (obj.type === 'user' && isRecord(obj.message) && Array.isArray(obj.message.content)) {
      for (const block of obj.message.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'tool_result') {
          onEvent({
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            content: stringifyToolResult(block.content),
            isError: Boolean(block.is_error),
          });
        }
      }
      return;
    }

    if (obj.type === 'result') {
      onEvent({
        type: 'usage',
        usage: obj.usage ?? null,
        costUsd: obj.total_cost_usd ?? null,
        durationMs: obj.duration_ms ?? null,
        stopReason: obj.stop_reason ?? null,
      });
      return;
    }
  }

  function handleStreamEvent(ev: Record<string, unknown>) {
    if (ev.type === 'message_start') {
      currentMessageId = isRecord(ev.message) && typeof ev.message.id === 'string' ? ev.message.id : null;
      if (typeof ev.ttft_ms === 'number') {
        onEvent({ type: 'status', label: 'streaming', ttftMs: ev.ttft_ms });
      }
      return;
    }

    if (ev.type === 'content_block_start' && isRecord(ev.content_block)) {
      const key = blockKey(ev.index);
      const block = ev.content_block;
      blocks.set(key, { type: block.type, name: block.name, id: block.id, input: '' });
      if (block.type === 'thinking') {
        onEvent({ type: 'thinking_start' });
      }
      return;
    }

    if (ev.type === 'content_block_delta' && isRecord(ev.delta)) {
      const state = blocks.get(blockKey(ev.index));
      const delta = ev.delta;

      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        if (currentMessageId) textStreamed.add(currentMessageId);
        onEvent({ type: 'text_delta', delta: delta.text });
        return;
      }
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        if (currentMessageId) textStreamed.add(currentMessageId);
        onEvent({ type: 'thinking_delta', delta: delta.thinking });
        return;
      }
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        if (state && state.type === 'tool_use') {
          state.input += delta.partial_json;
        }
        return;
      }
    }

    if (ev.type === 'content_block_stop') {
      const key = blockKey(ev.index);
      const state = blocks.get(key);
      if (state && state.type === 'tool_use' && typeof state.id === 'string' && state.input.trim()) {
        try {
          emitToolUseOnce(state.id, state.name, JSON.parse(state.input));
        } catch {
          // Let the final assistant wrapper provide the complete input.
        }
      }
      blocks.delete(key);
      return;
    }
  }

  function emitToolUseOnce(id: unknown, name: unknown, input: unknown) {
    if (typeof id === 'string') {
      if (emittedToolUseIds.has(id)) return;
      emittedToolUseIds.add(id);
    }

    onEvent({
      type: 'tool_use',
      id,
      name,
      input,
    });
  }

  return { feed, flush };
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isRecord(c) && c.type === 'text' ? String(c.text) : JSON.stringify(c)))
      .join('\n');
  }
  return JSON.stringify(content);
}
