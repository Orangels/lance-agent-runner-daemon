import type { DemoArtifact, DemoChatMessage, DemoRunEvent } from '../chat/chat-types.js';
import { ArtifactList } from './ArtifactList.js';
import { StatusPill } from './StatusPill.js';

interface AssistantMessageProps {
  message: DemoChatMessage;
  onDownloadArtifact: (artifact: DemoArtifact) => void;
}

export function AssistantMessage({ message, onDownloadArtifact }: AssistantMessageProps) {
  const { thinkingText, visibleEvents } = organizeAssistantEvents(message.events ?? []);
  const showWaiting = shouldShowWaitingPlaceholder(message, thinkingText, visibleEvents);

  return (
    <article className="msg assistant">
      <div className="msg-meta">
        <span>assistant</span>
        {message.runStatus ? <StatusPill status={message.runStatus} /> : null}
      </div>
      <div className="assistant-flow">
        {thinkingText ? <ThinkingBlock text={thinkingText} /> : null}
        {message.content ? <p className="assistant-text">{message.content}</p> : <WaitingBlock show={showWaiting} />}
        {visibleEvents.map((event, index) => (
          <EventBlock event={event} key={`${event.id ?? index}-${event.type}`} />
        ))}
        {message.error ? (
          <div className="assistant-error">
            <strong>{message.error.code ?? 'ERROR'}</strong>
            <span>{message.error.message}</span>
          </div>
        ) : null}
        <ArtifactList artifacts={message.artifacts ?? []} onDownloadArtifact={onDownloadArtifact} />
      </div>
    </article>
  );
}

function organizeAssistantEvents(events: DemoRunEvent[]): {
  thinkingText: string;
  visibleEvents: DemoRunEvent[];
} {
  let thinkingText = '';
  const visibleEvents: DemoRunEvent[] = [];

  for (const event of events) {
    if (event.type === 'thinking_delta' && typeof event.delta === 'string') {
      thinkingText += event.delta;
      continue;
    }

    if (event.type === 'thinking_start') {
      continue;
    }

    if (event.type === 'tool_use' && event.name === 'Agent') {
      continue;
    }

    visibleEvents.push(event);
  }

  return { thinkingText, visibleEvents };
}

function shouldShowWaitingPlaceholder(
  message: DemoChatMessage,
  thinkingText: string,
  visibleEvents: DemoRunEvent[],
): boolean {
  if (
    !message.runStatus ||
    message.runStatus === 'succeeded' ||
    message.runStatus === 'failed' ||
    message.runStatus === 'canceled' ||
    message.runStatus === 'interrupted'
  ) {
    return false;
  }
  if (message.content || thinkingText || message.error || (message.artifacts ?? []).length > 0) {
    return false;
  }
  return visibleEvents.every((event) => event.type === 'status' || event.type === 'assistant_message_start');
}

function WaitingBlock({ show }: { show: boolean }) {
  if (!show) {
    return null;
  }
  return <div className="waiting-pill">Waiting for Agent...</div>;
}

function ThinkingBlock({ text }: { text: string }) {
  return (
    <details className="thinking-block" open>
      <summary>Thinking</summary>
      <p>{text}</p>
    </details>
  );
}

function EventBlock({ event }: { event: DemoRunEvent }) {
  if (event.type === 'status' && typeof event.label === 'string') {
    return <StatusPill label={event.label} />;
  }

  if (event.type === 'tool_use') {
    return (
      <div className="tool-card">
        <strong>{typeof event.name === 'string' ? event.name : 'Tool use'}</strong>
        <pre>{JSON.stringify(event.input ?? {}, null, 2)}</pre>
      </div>
    );
  }

  if (event.type === 'tool_result') {
    return (
      <div className={`tool-card ${event.isError ? 'is-error' : ''}`}>
        <strong>Tool result</strong>
        <p>{typeof event.content === 'string' ? event.content : ''}</p>
      </div>
    );
  }

  if (event.type === 'usage') {
    return <div className="assistant-footer">Usage captured</div>;
  }

  if (event.type === 'end') {
    return <div className="assistant-footer">Completed: {String(event.status ?? 'done')}</div>;
  }

  return null;
}
